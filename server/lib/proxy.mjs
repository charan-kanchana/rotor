import { Readable } from 'node:stream';
import { statsFor, logEvent, persistSoon } from './config.mjs';
import { anthropicToOpenAI, openaiToAnthropicStream } from './translate.mjs';

// A hung provider used to stall a request for 60s before failover; 20s still
// covers slow thinking-model headers while cutting the worst case by 3x.
const HEADER_TIMEOUT_MS = 20_000;

export const COOLDOWNS = {
  auth: 60 * 60_000,
  payment: 30 * 60_000,
  rate: 5 * 60_000,
  notfound: 2 * 60_000,
  server: 60_000,
  network: 30_000,
};

const RETRYABLE_STATUS = new Set([401, 402, 403, 404, 408, 429, 500, 502, 503, 504, 529]);

export function enabledSorted(cfg) {
  return cfg.providers
    .filter((p) => p.enabled)
    .slice()
    .sort((a, b) => (a.priority || 99) - (b.priority || 99));
}

export function isDown(stats) {
  return (stats.deadUntil || 0) > Date.now();
}

function classify(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'payment';
  if (status === 429) return 'rate';
  if (status === 404) return 'notfound';
  return 'server';
}

function cooldownMs(kind, retryAfterSec, stats) {
  let ms = COOLDOWNS[kind];
  if (retryAfterSec && Number.isFinite(retryAfterSec)) {
    ms = Math.max(ms, retryAfterSec * 1000);
  }
  const backoff = Math.min(2 ** Math.min(stats.consecutiveFailures || 0, 3), 8);
  return ms * backoff;
}

function markDown(cfg, p, kind, detail, retryAfterSec) {
  const s = statsFor(cfg, p.id);
  s.consecutiveFailures = (s.consecutiveFailures || 0) + 1;
  s.deadUntil = Date.now() + cooldownMs(kind, retryAfterSec, s);
  s.deadReason = `${kind}: ${String(detail).slice(0, 200)}`;
  s.lastError = { ts: Date.now(), kind, detail: String(detail).slice(0, 300) };
  s.lastCheck = Date.now();
  logEvent(
    cfg,
    `Provider "${p.name}" down (${kind}${retryAfterSec ? `, retry-after ${retryAfterSec}s` : ''}) — cooldown ${Math.round((s.deadUntil - Date.now()) / 1000)}s. Detail: ${String(detail).slice(0, 120)}`
  );
}

function markSuccess(cfg, p, latencyMs) {
  const s = statsFor(cfg, p.id);
  s.requests++;
  s.successes++;
  s.consecutiveFailures = 0;
  s.deadUntil = 0;
  s.deadReason = null;
  s.emaLatencyMs = s.emaLatencyMs == null
    ? latencyMs
    : Math.round(s.emaLatencyMs * 0.7 + latencyMs * 0.3);
  persistSoon(cfg);
}

export function mapModel(p, model) {
  if (typeof model !== 'string') return model;
  const base = model.replace(/\[.*\]$/, '');           // strip [1m], [200k] etc.
  const m = /^rotor:(opus|fable|sonnet|haiku)$/i.exec(base);
  if (m) {
    const slot = m[1].toLowerCase();
    const models = p.models || {};
    return models[slot] || models.sonnet || model;
  }
  // standard Anthropic model names -> map to provider slots
  const low = base.toLowerCase();
  if (low.includes('opus')) return (p.models || {}).opus || base;
  if (low.includes('fable')) return (p.models || {}).fable || (p.models || {}).sonnet || base;
  if (low.includes('sonnet')) return (p.models || {}).sonnet || base;
  if (low.includes('haiku')) return (p.models || {}).haiku || base;
  return model;
}

function targetUrl(baseUrl, url) {
  let base = String(baseUrl || '').replace(/\/+$/, '');
  const path = url;
  if (/\/v\d+$/.test(base) && /^\/v\d+\//.test(path)) {
    base = base.replace(/\/v\d+$/, '');
  }
  return base + path;
}

function buildHeaders(p, req, protocolOpenai = false) {
  if (protocolOpenai) {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${p.apiKey}`,
      'user-agent': req.headers['user-agent'] || 'claude-cli/2.0.14 (external, cli)',
    };
  }
  const h = {
    'content-type': req.headers['content-type'] || 'application/json',
    accept: req.headers['accept'] || '*/*',
  };
  for (const k of ['anthropic-beta', 'anthropic-version']) {
    if (req.headers[k]) h[k] = req.headers[k];
  }
  h['user-agent'] = req.headers['user-agent'] || 'claude-cli/2.0.14 (external, cli)';
  const style = p.authStyle || 'auto';
  if (style === 'bearer') {
    h['authorization'] = `Bearer ${p.apiKey}`;
  } else if (style === 'anthropic') {
    h['x-api-key'] = p.apiKey;
    if (!h['anthropic-version']) h['anthropic-version'] = '2023-06-01';
  } else {
    h['x-api-key'] = p.apiKey;
    h['authorization'] = `Bearer ${p.apiKey}`;
    if (!h['anthropic-version']) h['anthropic-version'] = '2023-06-01';
  }
  return h;
}

function sanitizeRespHeaders(headers) {
  const h = {};
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') continue;
    h[k] = v;
  }
  return h;
}

async function attempt(p, req, rawBody, cfg) {
  let body;
  let mappedModel = null;
  let protocolOpenai = p.protocol === 'openai';
  let targetPath = null;
  if (rawBody && rawBody.length && req.method !== 'GET' && req.method !== 'HEAD') {
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('json')) {
      try {
        const json = JSON.parse(rawBody.toString('utf8'));
        if (typeof json.model === 'string') {
          mappedModel = mapModel(p, json.model);
          json.model = mappedModel;
        }
        if (protocolOpenai) {
          body = JSON.stringify(anthropicToOpenAI(json));
          targetPath = '/chat/completions';
        } else {
          body = JSON.stringify(json);
        }
      } catch {
        body = rawBody;
      }
    } else {
      body = rawBody;
    }
  }

  // Slow gateways can opt out of the 20s cap with a per-provider headerTimeoutMs.
  const headerMs = Number(p.headerTimeoutMs) > 0 ? Number(p.headerTimeoutMs) : HEADER_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), headerMs);
  try {
    const url = targetPath
      ? String(p.baseUrl || '').replace(/\/+$/, '') + targetPath
      : targetUrl(p.baseUrl, req.url);
    const resp = await fetch(url, {
      method: req.method,
      headers: buildHeaders(p, req, protocolOpenai),
      body,
      signal: ac.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let retryAfterSec;
      const ra = resp.headers.get('retry-after');
      if (ra) {
        const asInt = parseInt(ra, 10);
        retryAfterSec = Number.isFinite(asInt) && String(asInt) === ra.trim()
          ? asInt
          : (Date.parse(ra) - Date.now()) / 1000;
      }
      return { ok: false, status: resp.status, text, retryAfterSec, ac };
    }
    return { ok: true, resp, ac, mappedModel, protocolOpenai };
  } finally {
    clearTimeout(timer);
  }
}

// Priority stays authoritative unless latencyFirst (config.json) is set; in
// both modes measured EMA latency breaks ties and unknown latency sorts last.
export function orderCandidates(cfg, list) {
  const lat = (p) => statsFor(cfg, p.id).emaLatencyMs ?? Infinity;
  const prio = (p) => p.priority || 99;
  return list.slice().sort((a, b) => (cfg.latencyFirst
    ? lat(a) - lat(b) || prio(a) - prio(b)
    : prio(a) - prio(b) || lat(a) - lat(b)));
}

let lastAllDownReset = 0;
const ALL_DOWN_RESET_MS = 60_000;

export async function handleProxy(req, res, cfg, rawBody) {
  let candidates = enabledSorted(cfg).filter((p) => !isDown(statsFor(cfg, p.id)));

  let allDownCooling = false;
  if (!candidates.length) {
    const all = enabledSorted(cfg);
    if (all.length && Date.now() - lastAllDownReset > ALL_DOWN_RESET_MS) {
      lastAllDownReset = Date.now();
      logEvent(cfg, 'All providers down — resetting cooldowns and retrying');
      for (const p of all) statsFor(cfg, p.id).deadUntil = 0;
      candidates = all;
    } else if (all.length) {
      allDownCooling = true;
    }
  }

  if (!candidates.length) {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: allDownCooling
          ? `rotor: all providers are down — retrying them at most once per minute. Open http://127.0.0.1:${cfg.port} to check status.`
          : `rotor: no enabled providers configured. Open http://127.0.0.1:${cfg.port} to add one.`,
      },
    }));
    return;
  }

  candidates = orderCandidates(cfg, candidates);

  let lastErr = null;
  for (const p of candidates) {
    const t0 = Date.now();
    try {
      const r = await attempt(p, req, rawBody, cfg);
      if (r.ok) {
        logEvent(cfg, `→ ${p.name} (${Date.now() - t0}ms)`);
        markSuccess(cfg, p, Date.now() - t0);
        res.writeHead(r.resp.status, sanitizeRespHeaders(r.resp.headers));

        // immediate flush + no Nagle delay
        res.flushHeaders();
        if (res.socket) res.socket.setNoDelay(true);

        let stream = Readable.fromWeb(r.resp.body);
        if (r.protocolOpenai) {
          stream = stream.pipe(openaiToAnthropicStream(r.mappedModel || ''));
        }

        res.on('close', () => r.ac.abort());
        stream.on('error', (err) => {
          if (err?.name !== 'AbortError') {
            logEvent(cfg, `Stream from "${p.name}" broke mid-body (${err?.message || err})`);
          }
          try { if (!res.writableEnded) res.end(); } catch {}
        });

        stream.pipe(res);
        return;
      }

      const s = statsFor(cfg, p.id);
      s.requests++;
      s.failures++;
      lastErr = r;

      if (RETRYABLE_STATUS.has(r.status)) {
        markDown(cfg, p, classify(r.status), `${r.status} ${r.text.slice(0, 200)}`, r.retryAfterSec);
        continue;
      }

      persistSoon(cfg);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.text);
      return;
    } catch (err) {
      const s = statsFor(cfg, p.id);
      s.requests++;
      s.failures++;
      const code = err.cause?.code || (err.name === 'AbortError' ? 'timeout' : err.message);
      markDown(cfg, p, 'network', code);
      lastErr = { status: 502, text: code };
      continue;
    }
  }

  res.writeHead(lastErr?.status || 502, {
    'content-type': 'application/json',
    'x-rotor-error': 'all providers failed',
  });
  res.end(JSON.stringify({
    type: 'error',
    error: {
      type: 'api_error',
      message: `rotor: all providers failed. Last error: ${lastErr?.status || 'unknown'} ${String(lastErr?.text || '').slice(0, 200)}`,
    },
  }));
}
