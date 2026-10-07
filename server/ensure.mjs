#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from './lib/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = load();
const port = cfg.port || 8787;
const BASE = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp(timeoutMs = 800) {
  try {
    const resp = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return Boolean(resp?.ok);
  } catch {
    return false;
  }
}

function spawnServer() {
  const serverPath = path.join(__dirname, 'server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function readStdin(timeoutMs = 150) {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    let data = '';
    const finish = (val) => {
      clearTimeout(timer);
      try { process.stdin.destroy(); } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => {
      try { finish(JSON.parse(data)); } catch { finish(null); }
    });
    process.stdin.on('error', () => finish(null));
  });
}

async function notifySession(action, payload) {
  try {
    await fetch(`${BASE}/api/session/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: payload?.session_id,
        pid: process.ppid,
      }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* server unreachable or shutting down */
  }
}

const isEnd = process.argv.includes('--end');
const payload = await readStdin();

if (isEnd) {
  await notifySession('end', payload);
  process.exit(0);
}

if (!(await isUp())) {
  spawnServer();
  for (let i = 0; i < 25; i++) {
    await sleep(150);
    if (await isUp()) break;
  }
}

if (await isUp()) {
  await notifySession('start', payload);
} else {
  console.error('rotor: proxy failed to start on ' + BASE);
  process.exit(1);
}
