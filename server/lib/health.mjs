// rotor — background health checks.
//
// A provider's cooldown expiry alone restores it to rotation. This loop probes
// slightly before expiry so a recovered provider is confirmed (and logged)
// before Claude Code's next request hits it, and it keeps stale reasons from
// lingering in the dashboard.

import { statsFor, logEvent, persistSoon } from './config.mjs';

const PROBE_LEAD_MS = 10_000;
const RECHECK_MS = 30_000;
const LOOP_MS = 5_000;
const PROBE_TIMEOUT_MS = 10_000;
const CLAUDE_UA = 'claude-cli/2.0.14 (external, cli)';

export function drain(resp) {
  try { resp.body?.cancel().catch(() => {}); } catch {}
}

function authHeaders(p) {
  const h = { 'user-agent': CLAUDE_UA, 'content-type': 'application/json' };
  const style = p.authStyle || 'auto';
  const isOpenai = p.protocol === 'openai';
  if (style === 'bearer' || (style === 'auto' && isOpenai)) {
    h.authorization = `Bearer ${p.apiKey}`;
  } else if (style === 'anthropic' || (style === 'auto' && !isOpenai)) {
    h['x-api-key'] = p.apiKey;
    h['anthropic-version'] = '2023-06-01';
  } else {
    h['x-api-key'] = p.apiKey;
    h.authorization = `Bearer ${p.apiKey}`;
    h['anthropic-version'] = '2023-06-01';
  }
  return h;
}

export async function fetchModels(p) {
  let base = String(p.baseUrl || '').replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const headers = { 'user-agent': 'rotor/1.0' };
  if (p.apiKey) {
    headers.authorization = `Bearer ${p.apiKey}`;
    headers['x-api-key'] = p.apiKey;
  }
  try {
    return await fetch(url, { headers, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Universal auth and reachability check for any LLM provider.
// Probes the completion endpoint with a minimal body. Invalid keys return 401/403,
// valid keys pass authentication (returning 400 bad request for empty probe messages),
// and network/server errors are caught cleanly in a single pass.
export async function checkAuth(p) {
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  const isOpenai = p.protocol === 'openai';
  const path = isOpenai ? '/chat/completions' : (base.endsWith('/v1') ? '/messages' : '/v1/messages');
  const url = base + path;
  const probeModel = Object.values(p.models || {}).find(Boolean) || 'probe';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: authHeaders(p),
      body: JSON.stringify({ model: probeModel, messages: [] }),
      signal: ac.signal,
    });
    if (resp.ok) {
      drain(resp);
      return { ok: true };
    }
    if (resp.status === 401 || resp.status === 403) {
      drain(resp);
      return { ok: false, error: `Authentication failed (${resp.status}) — check your API key` };
    }
    if (resp.status === 404) {
      drain(resp);
      return { ok: false, error: 'Endpoint not found (404) — check Base URL and protocol' };
    }
    if (resp.status === 405) {
      drain(resp);
      return { ok: false, error: 'Method not allowed (405) — check Base URL and protocol' };
    }
    if (resp.status >= 500) {
      drain(resp);
      return { ok: false, error: `Provider server error (${resp.status})` };
    }

    let errBody = null;
    try {
      errBody = await resp.json();
    } catch {
      drain(resp);
      return { ok: false, error: `Request rejected (${resp.status})` };
    }

    const err = errBody?.error || errBody;
    const msg = (typeof err === 'string' ? err : err?.message) || errBody?.message || errBody?.detail || '';
    const code = String(err?.code || errBody?.code || '');
    const type = String(err?.type || errBody?.type || '');

    if (/auth|key|token|credential|unauthorized/i.test(msg) || /auth|key|unauthorized/i.test(code) || /authentication_error/i.test(type)) {
      return { ok: false, error: msg ? `Authentication failed: ${msg}` : `Authentication failed (${resp.status})` };
    }
    if (code === 'unsupported_model_schema' || /unsupported.*schema|protocol mismatch/i.test(msg)) {
      return { ok: false, error: `Protocol mismatch: ${msg || 'schema not supported'}` };
    }
    if (code === 'model_unavailable' || /model.*unavailable|model.*not found/i.test(msg)) {
      return { ok: false, error: msg || `Model "${probeModel}" unavailable` };
    }
    if (/message|prompt|input required|empty/i.test(msg)) {
      return { ok: true };
    }
    return { ok: false, error: msg || `Provider rejected probe (${resp.status})` };
  } catch (err) {
    return { ok: false, error: `Endpoint unreachable (${base}): ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function probe(p) {
  const auth = await checkAuth(p);
  return auth.ok;
}

export async function deepCheck(p) {
  const auth = await checkAuth(p);
  if (!auth.ok) {
    return { ok: false, missing: [], error: auth.error };
  }

  const configured = Object.entries(p.models || {})
    .filter(([, id]) => id)
    .map(([slot, id]) => ({ slot, id }));
  if (!configured.length) {
    return { ok: true, missing: [] };
  }

  let resp;
  try {
    resp = await fetchModels(p);
  } catch {
    return { ok: true, missing: [] };
  }
  if (!resp.ok) {
    drain(resp);
    return { ok: true, missing: [] };
  }

  try {
    const data = await resp.json();
    const ids = new Set((data.data || data.models || []).map((m) => m && (m.id || m.name)).filter(Boolean));
    if (!ids.size) return { ok: true, missing: [] };
    const missing = configured.filter(({ id }) => !ids.has(id)).map(({ slot, id }) => `${slot}:${id}`);
    return { ok: true, missing };
  } catch {
    return { ok: true, missing: [] };
  }
}

export async function warmActive(cfg) {
  const p = cfg.providers.filter((x) => x.enabled && x.apiKey)
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))[0];
  if (!p) return;
  try { drain(await fetchModels(p)); } catch {}
}

export function startHealthLoop(getCfg) {
  const timer = setInterval(async () => {
    const cfg = getCfg();
    for (const p of cfg.providers) {
      if (!p.enabled || !p.apiKey) continue;
      const s = statsFor(cfg, p.id);
      if (!s.deadUntil || s.deadUntil <= Date.now()) continue;
      const due = s.deadUntil - Date.now() <= PROBE_LEAD_MS
        || Date.now() - (s.lastCheck || 0) >= RECHECK_MS;
      if (!due) continue;

      s.lastCheck = Date.now();
      if (await probe(p)) {
        s.deadUntil = 0;
        s.deadReason = null;
        s.consecutiveFailures = 0;
        logEvent(cfg, `Provider "${p.name}" recovered — back in rotation`);
        persistSoon(cfg);
      }
    }
  }, LOOP_MS);
  if (timer.unref) timer.unref();
  return timer;
}
