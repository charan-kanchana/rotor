#!/usr/bin/env node
// rotor — the proxy server.
//
// Routes:
//   /            web dashboard
//   /healthz     liveness ping (used by ensure.mjs and the dashboard)
//   /api/*       management API (providers, status, events)
//   anything else is forwarded to the active provider (Anthropic API shape:
//   /v1/messages, /v1/messages/count_tokens, ...)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, LOG_PATH, CONFIG_PATH } from './lib/config.mjs';
import { handleProxy } from './lib/proxy.mjs';
import { handleApi } from './lib/api.mjs';
import { startHealthLoop, warmActive } from './lib/health.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');

// The proxy is bound to 127.0.0.1 and holds provider API keys in memory, so
// requests must actually come from this machine. A page at attacker.test can
// rebind its DNS to 127.0.0.1, making its fetches same-origin and invisible
// to CORS — unless the Host header is checked. Every accepted request must
// name us as its host, and any Origin header must be our own origin.
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function hostAllowed(host) {
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  return LOCAL_HOSTNAMES.has(hostname);
}
function originAllowed(origin, port) {
  if (!origin || origin === 'null') return false;
  try {
    const u = new URL(origin);
    // Browsers omit the port for the scheme default (http→80, https→443);
    // u.port would be '' — compare the effective port, not the raw string.
    const effective = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
    return effective === String(port) && LOCAL_HOSTNAMES.has(u.hostname.replace(/^\[|\]$/g, '') || u.hostname);
  } catch {
    return false;
  }
}
function forbidden(res, why) {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: `rotor: request rejected (${why}). This proxy only accepts requests addressed to 127.0.0.1:${PORT}.` }));
}

const cfg = load();
const PORT = cfg.port || 8787;
const MAX_BODY = 200 * 1024 * 1024; // matches current provider request-body limits
const STARTED_AT = Date.now();
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
let lastActivity = Date.now();

const sessions = new Map();

function getLiveSessions() {
  for (const [id, s] of sessions.entries()) {
    if (s.pid) {
      try {
        process.kill(s.pid, 0);
      } catch {
        sessions.delete(id);
      }
    }
  }
  return sessions;
}

let emptySince = Date.now();

function readRawBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveFile(res, filePath) {
  try {
    const html = fs.readFileSync(filePath);
    // no-store: the dashboard file changes between plugin versions and during
    // development; a heuristically-cached stale copy breaks the UI in ways
    // that look like random bugs (half-loaded scripts, dead buttons).
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('rotor: file missing: ' + filePath);
  }
}

const server = http.createServer(async (req, res) => {
  // Applies to every route, proxied traffic included: rebinding protection.
  if (req.headers.origin !== undefined && !originAllowed(req.headers.origin, PORT)) {
    forbidden(res, `bad origin ${req.headers.origin}`);
    return;
  }
  if (!hostAllowed(req.headers.host)) {
    forbidden(res, `bad host ${req.headers.host}`);
    return;
  }
  const pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  if (pathname !== '/healthz' && !pathname.startsWith('/api/session/')) {
    lastActivity = Date.now();
  }

  try {
    if (pathname === '/healthz') {
      const active = getLiveSessions().size;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        port: PORT,
        activeSessions: active,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000)
      }));
      return;
    }

    if (pathname === '/api/session/start' && req.method === 'POST') {
      const raw = await readRawBody(req);
      const data = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      const key = data.sessionId || (data.pid ? `pid_${data.pid}` : `s_${Date.now()}`);
      sessions.set(key, { pid: data.pid, sessionId: data.sessionId, startedAt: Date.now() });
      emptySince = null;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, activeSessions: getLiveSessions().size }));
      return;
    }

    if (pathname === '/api/session/end' && req.method === 'POST') {
      const raw = await readRawBody(req);
      const data = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      const key = data.sessionId || (data.pid ? `pid_${data.pid}` : null);
      if (key && sessions.has(key)) {
        sessions.delete(key);
      } else if (data.pid) {
        for (const [k, s] of sessions.entries()) {
          if (s.pid === data.pid) sessions.delete(k);
        }
      }
      const remaining = getLiveSessions().size;
      if (remaining === 0 && emptySince === null) {
        emptySince = Date.now();
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, activeSessions: remaining }));
      return;
    }

    if (pathname === '/shutdown' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'shutting down' }));
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (pathname === '/' || pathname === '/index.html' || pathname === '/favicon.ico') {
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      serveFile(res, INDEX_PATH);
      return;
    }


    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, cfg);
      return;
    }

    // Everything else: Anthropic API traffic → proxy it.
    const rawBody = await readRawBody(req);
    await handleProxy(req, res, cfg, rawBody);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
    }
    try {
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `rotor: ${err.message}` } }));
    } catch {
      /* connection already gone */
    }
    console.error(`[rotor] ${req.method} ${pathname} failed:`, err.message);
  }
});

// 127.0.0.1 only — API keys live in this process; never expose on the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`rotor proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`config: ${CONFIG_PATH}`);
});

const idleTimer = setInterval(() => {
  const live = getLiveSessions();
  if (live.size > 0) {
    emptySince = null;
    return;
  }
  if (emptySince === null) {
    emptySince = Date.now();
  }
  if (Date.now() - emptySince >= IDLE_TIMEOUT_MS && Date.now() - lastActivity >= IDLE_TIMEOUT_MS) {
    console.log('[rotor] No active sessions for 15 minutes — shutting down');
    process.exit(0);
  }
}, 30_000);
idleTimer.unref();

startHealthLoop(() => cfg);
// Fire-and-forget: preconnect while Claude Code is still starting up.
warmActive(cfg);

process.on('SIGINT', () => {
  console.log('rotor shutting down');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(LOG_PATH, `[uncaught] ${new Date().toISOString()} ${err.stack || err.message}\n`); } catch { /* ignore */ }
});
