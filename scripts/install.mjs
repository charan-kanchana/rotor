#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from '../server/lib/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENSURE_PATH = path.join(ROOT, 'server', 'ensure.mjs');

const cfg = load();
const port = cfg.port || 8787;
const BASE = `http://127.0.0.1:${port}`;

async function isUp() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1200);
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: ac.signal });
      return Boolean(r?.ok);
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

async function ensureRunning() {
  if (await isUp()) return true;
  spawnSync(process.execPath, [ENSURE_PATH], { stdio: 'inherit' });
  return await isUp();
}

// Upsert a hook entry into a SessionStart/SessionEnd array without touching
// any other existing hooks the user may have installed (MCP hooks, other tools, etc.)
function upsertHook(hookArray, matchCommand, newCommand, extraGroupProps = {}) {
  const existingGroup = hookArray.find((g) =>
    g?.hooks?.some((h) => typeof h?.command === 'string' && h.command.includes(matchCommand))
  );
  if (existingGroup) {
    const existingHook = existingGroup.hooks.find((h) => h?.command?.includes(matchCommand));
    if (existingHook) existingHook.command = newCommand;
  } else {
    hookArray.push({ ...extraGroupProps, hooks: [{ type: 'command', command: newCommand }] });
  }
}

async function main() {
  console.log('rotor — Claude Code Setup\n');

  if (!(await ensureRunning())) {
    console.error(`ERROR: Proxy could not be started at ${BASE}.`);
    process.exit(1);
  }

  let status;
  try {
    const res = await fetch(`${BASE}/api/status`);
    status = await res.json();
  } catch (err) {
    console.error(`ERROR: Failed to connect to proxy status endpoint: ${err.message}`);
    process.exit(1);
  }

  const providers = status.providers || [];
  const ready = providers.filter((p) => p.enabled && p.maskedKey);

  if (!ready.length) {
    console.error('ERROR: No enabled provider with an API key is configured yet.\n');
    console.error('Why this matters:');
    console.error('Claude Code routes all traffic through this proxy once configured.');
    console.error('Without a working provider, Claude Code would have no API access.\n');
    console.error('Please do this first:');
    console.error(`  1. Open http://127.0.0.1:${port} in your browser`);
    console.error('  2. Add your provider and API key (or pick from the catalog)');
    console.error('  3. Click "Test" to verify it');
    console.error('  4. Re-run: npm run setup\n');
    process.exit(1);
  }

  console.log(`✓ Provider ready: ${ready.map((p) => p.name).join(', ')}`);

  const settingsDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  const backupPath = path.join(settingsDir, 'settings.json.rotor-backup');

  fs.mkdirSync(settingsDir, { recursive: true });

  // Load existing settings so we don't disturb any hooks/config the user already has.
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      settings = {};
    }
    // Back up only once so the original pre-rotor state is always recoverable.
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(settingsPath, backupPath);
      console.log(`✓ Saved backup of original settings to: ${backupPath}`);
    }
  }

  // Merge only rotor-owned env keys; leave every other env var the user has untouched.
  settings.env = settings.env || {};
  settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  settings.env.ANTHROPIC_AUTH_TOKEN = 'rotor-local';
  settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'rotor:opus';
  settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'rotor:fable';
  settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'rotor:sonnet';
  settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'rotor:haiku';

  // Hooks: ensure the rotor entry exists without removing or modifying any
  // other hooks the user has set up (e.g. MCP hooks, other tool hooks).
  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart : [];
  settings.hooks.SessionEnd = Array.isArray(settings.hooks.SessionEnd)
    ? settings.hooks.SessionEnd : [];

  upsertHook(
    settings.hooks.SessionStart,
    'ensure.mjs',
    `node "${ENSURE_PATH}"`,
    { matcher: '^(startup|resume|clear|compact|fork)$' }
  );
  upsertHook(
    settings.hooks.SessionEnd,
    'ensure.mjs',
    `node "${ENSURE_PATH}" --end`
  );

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  console.log(`✓ Updated ${settingsPath}`);
  console.log('✓ Auto-start hook registered (proxy starts automatically with `claude`)');
  console.log('✓ Session-aware auto-shutdown enabled (15 min after all sessions close)\n');
  console.log('Setup complete! You can now start Claude Code by typing `claude`.');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
