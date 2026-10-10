import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DIR = process.env.ROTOR_HOME
  ? path.resolve(process.env.ROTOR_HOME)
  : path.join(os.homedir(), '.rotor');
export const CONFIG_PATH = path.join(DIR, 'config.json');
export const LOG_PATH = path.join(DIR, 'server.log');

export const DEFAULT_PORT = 8787;
export const LOCAL_TOKEN = 'rotor-local';
export const PROCESS_START = Date.now();

const DEFAULTS = {
  port: DEFAULT_PORT,
  providers: [],
  stats: {},
  events: [],
};

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const cfg = { ...structuredClone(DEFAULTS), ...raw };
    if (!Array.isArray(cfg.providers)) cfg.providers = [];
    if (!cfg.stats || typeof cfg.stats !== 'object') cfg.stats = {};
    if (!Array.isArray(cfg.events)) cfg.events = [];
    return cfg;
  } catch (err) {
    let fileExisted = false;
    try { fileExisted = fs.statSync(CONFIG_PATH).size > 0; } catch { /* absent */ }
    if (fileExisted) {
      const backupPath = `${CONFIG_PATH}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(CONFIG_PATH, backupPath); } catch {}
      console.error(`rotor: config.json unreadable (${err.message}) — backed up to ${backupPath}`);
    }
    const cfg = structuredClone(DEFAULTS);
    save(cfg);
    return cfg;
  }
}

export function save(cfg) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

let saveTimer = null;
export function persistSoon(cfg, delayMs = 3000) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      save(cfg);
    } catch (err) {
      console.error('rotor: failed to save config:', err.message);
    }
  }, delayMs);
  if (saveTimer.unref) saveTimer.unref();
}

export function newId() {
  return crypto.randomUUID();
}

export function statsFor(cfg, id) {
  if (!cfg.stats[id]) {
    cfg.stats[id] = {
      requests: 0,
      successes: 0,
      failures: 0,
      emaLatencyMs: null,
      consecutiveFailures: 0,
      deadUntil: 0,
      deadReason: null,
      lastError: null,
      lastCheck: 0,
    };
  }
  const s = cfg.stats[id];
  for (const k of ['requests', 'successes', 'failures', 'consecutiveFailures', 'deadUntil', 'lastCheck']) {
    if (typeof s[k] !== 'number') s[k] = 0;
  }
  return s;
}

export function logEvent(cfg, msg) {
  cfg.events.unshift({ ts: Date.now(), msg });
  if (cfg.events.length > 200) cfg.events.length = 200;
  persistSoon(cfg);
}
