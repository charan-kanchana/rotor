import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, statsFor, logEvent, persistSoon, DIR, PROCESS_START } from './config.mjs';
import { enabledSorted, isDown, COOLDOWNS, orderCandidates } from './proxy.mjs';
import { deepCheck, fetchModels, drain, checkAuth } from './health.mjs';

const JSON_HDR = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_SEED_PATH = path.join(__dirname, '..', 'catalog.json');
const CATALOG_CACHE_PATH = path.join(DIR, 'catalog-cache.json');
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

function send(res, status, obj) {
  res.writeHead(status, JSON_HDR);
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return key.slice(0, 2) + '…';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function providerView(cfg, p) {
  const s = statsFor(cfg, p.id);
  const down = isDown(s);
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    maskedKey: maskKey(p.apiKey),
    authStyle: p.authStyle,
    protocol: p.protocol || 'anthropic',
    models: p.models || {},
    priority: p.priority,
    enabled: p.enabled,
    status: !p.enabled ? 'disabled' : down ? 'down' : 'up',
    statusDetail: down ? s.deadReason : null,
    downForMs: down ? s.deadUntil - Date.now() : 0,
    stats: {
      requests: s.requests,
      successes: s.successes,
      failures: s.failures,
      emaLatencyMs: s.emaLatencyMs,
      consecutiveFailures: s.consecutiveFailures,
      lastError: s.lastError,
    },
  };
}

function activeProviderName(cfg) {
  // Mirrors the request path's ordering so the dashboard names the provider actually tried first.
  const alive = orderCandidates(cfg, enabledSorted(cfg)).find((p) => !isDown(statsFor(cfg, p.id)));
  return alive ? alive.name : null;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadSeedCatalog() {
  return readJsonSafe(CATALOG_SEED_PATH) || { version: 1, providers: [] };
}

function loadRemoteCatalog() {
  return readJsonSafe(CATALOG_CACHE_PATH);
}

function mergedCatalog() {
  const seed = loadSeedCatalog();
  const remote = loadRemoteCatalog();
  const byId = new Map();
  for (const p of seed.providers || []) byId.set(p.id, p);
  for (const p of remote?.providers || []) {
    if (p && p.id && p.baseUrl) byId.set(p.id, { ...(byId.get(p.id) || {}), ...p, source: 'remote' });
  }
  return {
    version: seed.version,
    providers: [...byId.values()].sort((a, b) => (b.rating || 0) - (a.rating || 0)),
  };
}

const OFFICIAL_CATALOG_URL =
  'https://raw.githubusercontent.com/shaheer-00/switchXprovider/master/server/catalog.json';

async function refreshRemoteCatalog(cfg, url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const resp = await fetch(url, {
      headers: { 'user-agent': 'switchxprovider-catalog/1' },
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`catalog URL returned ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data.providers) || !data.providers.length) {
      throw new Error('catalog JSON must contain a non-empty "providers" array');
    }
    for (const p of data.providers) {
      if (!p.id || !p.baseUrl || !p.name) throw new Error('every catalog provider needs id, name, baseUrl');
    }
    const cache = { ...data, fetchedFrom: url, fetchedAt: Date.now() };
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CATALOG_CACHE_PATH, JSON.stringify(cache, null, 2));
    cfg.catalogUrl = url;
    persistSoon(cfg, 0);
    logEvent(cfg, `Provider catalog refreshed from ${url} (${data.providers.length} entries)`);
    return cache;
  } finally {
    clearTimeout(timer);
  }
}

function normalizePriorities(cfg) {
  const sorted = cfg.providers.slice().sort((a, b) => (a.priority || 99) - (b.priority || 99));
  sorted.forEach((p, i) => (p.priority = i + 1));
}

function sanitizeProviderInput(body) {
  const errors = [];
  const name = String(body.name || '').trim();
  const baseUrl = String(body.baseUrl || '').trim();
  if (!name) errors.push('name is required');
  if (!/^https?:\/\//.test(baseUrl)) errors.push('baseUrl must start with http:// or https://');
  const models = {};
  for (const slot of ['opus', 'sonnet', 'haiku']) {
    const v = String(body.models?.[slot] || '').trim();
    if (v) models[slot] = v;
  }
  return {
    errors,
    value: {
      name,
      baseUrl,
      apiKey: String(body.apiKey || '').trim(),
      authStyle: ['anthropic', 'bearer', 'auto'].includes(body.authStyle) ? body.authStyle : 'auto',
      protocol: body.protocol === 'openai' ? 'openai' : 'anthropic',
      enabled: body.enabled !== false,
      models,
    },
  };
}

export async function handleApi(req, res, pathname, cfg) {
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean);
  const [, resource, id, action] = parts;

  try {
    if (method === 'GET' && resource === 'status') {
      return send(res, 200, {
        version: PKG.version,
        port: cfg.port,
        uptimeSec: Math.round((Date.now() - PROCESS_START) / 1000),
        activeProvider: activeProviderName(cfg),
        cooldowns: COOLDOWNS,
        providers: enabledSorted(cfg)
          .concat(cfg.providers.filter((p) => !p.enabled))
          .map((p) => providerView(cfg, p)),
        events: cfg.events.slice(0, 50),
      });
    }

    if (method === 'GET' && resource === 'events') {
      return send(res, 200, { events: cfg.events });
    }

    if (method === 'POST' && resource === 'events' && id === 'clear') {
      cfg.events = [];
      persistSoon(cfg, 0);
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && resource === 'catalog') {
      return send(res, 200, mergedCatalog());
    }

    if (method === 'POST' && resource === 'catalog' && id === 'refresh') {
      const body = await readJson(req);
      const url = String(body.url || cfg.catalogUrl || '').trim();
      if (!/^https?:\/\//.test(url)) return send(res, 400, { error: 'url must start with http:// or https://' });
      try {
        const cache = await refreshRemoteCatalog(cfg, url);
        return send(res, 200, { ok: true, fetched: cache.providers.length });
      } catch (err) {
        return send(res, 502, { error: `catalog refresh failed: ${err.message}` });
      }
    }

    if (method === 'POST' && resource === 'catalog' && id === 'reset') {
      let fellBack = false;
      try {
        await refreshRemoteCatalog(cfg, OFFICIAL_CATALOG_URL);
      } catch {
        fellBack = true;
        try { fs.rmSync(CATALOG_CACHE_PATH, { force: true }); } catch {}
        delete cfg.catalogUrl;
        persistSoon(cfg, 0);
        logEvent(cfg, 'Provider catalog restored to official list (offline — using shipped catalog)');
      }
      return send(res, 200, { ok: true, offline: fellBack });
    }

    if (method === 'POST' && resource === 'providers' && id === 'fetch-models' && !action) {
      const body = await readJson(req);
      const baseUrl = String(body.baseUrl || '').trim();
      let apiKey = String(body.apiKey || '').trim();
      if (!apiKey && body.providerId) {
        const existing = cfg.providers.find((x) => x.id === body.providerId);
        if (existing) apiKey = existing.apiKey || '';
      }
      if (!/^https?:\/\//.test(baseUrl)) return send(res, 400, { error: 'baseUrl must start with http:// or https://' });
      if (!apiKey) return send(res, 400, { error: 'apiKey is required' });
      const target = {
        baseUrl,
        apiKey,
        authStyle: ['anthropic', 'bearer', 'auto'].includes(body.authStyle) ? body.authStyle : 'auto',
      };
      const auth = await checkAuth(target);
      if (!auth.ok) {
        return send(res, 200, { models: [], error: auth.error });
      }
      let resp2;
      try {
        resp2 = await fetchModels(target);
      } catch (e) {
        return send(res, 200, { models: [], error: `could not reach ${baseUrl} — ${e.message}` });
      }
      if (resp2.status === 401 || resp2.status === 403) {
        drain(resp2);
        return send(res, 200, { models: [], error: `authentication failed (${resp2.status}) — check the API key` });
      }
      if (resp2.status === 404 || resp2.status === 405) {
        drain(resp2);
        return send(res, 200, { models: [], error: 'this provider does not expose a model list — enter the model IDs manually' });
      }
      if (!resp2.ok) {
        drain(resp2);
        return send(res, 200, { models: [], error: `provider returned HTTP ${resp2.status}` });
      }
      try {
        const data = await resp2.json();
        const ids = [...new Set((data.data || data.models || [])
          .map((m) => m && (m.id || m.name))
          .filter((x) => typeof x === 'string' && x))].sort();
        if (!ids.length) return send(res, 200, { models: [], error: 'model list came back empty — enter the model IDs manually' });
        return send(res, 200, { models: ids });
      } catch {
        return send(res, 200, { models: [], error: 'model list is not valid JSON — enter the model IDs manually' });
      }
    }

    if (resource === 'providers') {
      if (method === 'POST' && !id) {
        const body = await readJson(req);
        const { errors, value } = sanitizeProviderInput(body);
        if (errors.length) return send(res, 400, { error: errors.join('; ') });
        if (!value.apiKey) return send(res, 400, { error: 'apiKey is required' });

        if (value.enabled) {
          const auth = await checkAuth(value);
          if (!auth.ok) {
            return send(res, 400, { error: auth.error || 'Provider verification failed' });
          }
        }

        const p = {
          id: newId(),
          ...value,
          priority: (cfg.providers.length || 0) + 1,
        };
        cfg.providers.push(p);
        logEvent(cfg, `Provider "${p.name}" verified & added (priority ${p.priority})`);
        persistSoon(cfg, 0);
        return send(res, 201, providerView(cfg, p));
      }

      if (method === 'PUT' && id) {
        const p = cfg.providers.find((x) => x.id === id);
        if (!p) return send(res, 404, { error: 'provider not found' });
        const body = await readJson(req);
        const { errors, value } = sanitizeProviderInput(body);
        if (errors.length) return send(res, 400, { error: errors.join('; ') });
        const effectiveKey = value.apiKey || p.apiKey || '';
        const testCandidate = { ...p, ...value, apiKey: effectiveKey };

        if (value.enabled !== false && (value.apiKey || value.baseUrl !== p.baseUrl)) {
          const auth = await checkAuth(testCandidate);
          if (!auth.ok) {
            return send(res, 400, { error: auth.error || 'Provider verification failed' });
          }
        }

        Object.assign(p, value);
        if (!value.apiKey) p.apiKey = effectiveKey;
        if (body.priority != null) p.priority = Math.max(1, parseInt(body.priority, 10) || 1);
        logEvent(cfg, `Provider "${p.name}" verified & updated`);
        persistSoon(cfg, 0);
        return send(res, 200, providerView(cfg, p));
      }

      if (method === 'DELETE' && id) {
        const idx = cfg.providers.findIndex((x) => x.id === id);
        if (idx === -1) return send(res, 404, { error: 'provider not found' });
        const [removed] = cfg.providers.splice(idx, 1);
        delete cfg.stats[id];
        normalizePriorities(cfg);
        logEvent(cfg, `Provider "${removed.name}" removed`);
        persistSoon(cfg, 0);
        return send(res, 200, { ok: true });
      }

      if (method === 'POST' && id && action) {
        const p = cfg.providers.find((x) => x.id === id);
        if (!p) return send(res, 404, { error: 'provider not found' });

        if (action === 'test') {
          const { ok, missing } = await deepCheck(p);
          const s = statsFor(cfg, p.id);
          if (ok && s.deadUntil) {
            s.deadUntil = 0;
            s.deadReason = null;
            logEvent(cfg, `Provider "${p.name}" passed manual test — back in rotation`);
          } else if (!ok) {
            logEvent(cfg, `Provider "${p.name}" failed manual test`);
          }
          if (missing.length) {
            logEvent(cfg, `Provider "${p.name}" missing model IDs: ${missing.join(', ')}`);
          }
          persistSoon(cfg, 0);
          return send(res, 200, { ok, missing });
        }

        if (action === 'reset') {
          const s = statsFor(cfg, p.id);
          s.deadUntil = 0;
          s.deadReason = null;
          s.consecutiveFailures = 0;
          logEvent(cfg, `Provider "${p.name}" state reset — back in rotation`);
          persistSoon(cfg, 0);
          return send(res, 200, { ok: true });
        }

        if (action === 'up' || action === 'down') {
          const sorted = cfg.providers.slice().sort((a, b) => (a.priority || 99) - (b.priority || 99));
          const idx = sorted.findIndex((x) => x.id === id);
          const swapWith = action === 'up' ? idx - 1 : idx + 1;
          if (swapWith >= 0 && swapWith < sorted.length) {
            const a = sorted[idx];
            const b = sorted[swapWith];
            const tmp = a.priority;
            a.priority = b.priority;
            b.priority = tmp;
            normalizePriorities(cfg);
            logEvent(cfg, `Priority changed: "${a.name}" → ${a.priority}, "${b.name}" → ${b.priority}`);
            persistSoon(cfg, 0);
          }
          return send(res, 200, { ok: true });
        }
      }
    }

    return send(res, 404, { error: `unknown API route: ${method} ${pathname}` });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
}
