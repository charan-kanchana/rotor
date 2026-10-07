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

async function main() {
  console.log('switchXprovider — Claude Code Setup\n');

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
    console.error(`Please do this first:`);
    console.error(`  1. Open http://127.0.0.1:${port} in your browser`);
    console.error(`  2. Add your provider and API key (or pick from the catalog)`);
    console.error(`  3. Click "Test" to verify it`);
    console.error(`  4. Re-run: npm run setup\n`);
    process.exit(1);
  }

  console.log(`✓ Provider ready: ${ready.map((p) => p.name).join(', ')}`);

  const settingsDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  const backupPath = path.join(settingsDir, 'settings.json.switchx-backup');

  fs.mkdirSync(settingsDir, { recursive: true });

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      settings = {};
    }
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(settingsPath, backupPath);
      console.log(`✓ Saved backup of original settings to: ${backupPath}`);
    }
  }

  // Set environment variables for Claude Code
  settings.env = settings.env || {};
  settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  settings.env.ANTHROPIC_AUTH_TOKEN = 'switchx-local';
  settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'switchx:opus';
  settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'switchx:sonnet';
  settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'switchx:haiku';

  // Configure SessionStart hook to auto-start proxy
  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart
    : [];

  const hookCommand = `node "${ENSURE_PATH}"`;
  const existingGroup = settings.hooks.SessionStart.find((g) =>
    g?.hooks?.some((h) => h?.command?.includes('ensure.mjs'))
  );

  if (existingGroup) {
    const existingHook = existingGroup.hooks.find((h) => h?.command?.includes('ensure.mjs'));
    existingHook.command = hookCommand;
  } else {
    settings.hooks.SessionStart.push({
      matcher: '^(startup|resume|clear|compact|fork)$',
      hooks: [
        {
          type: 'command',
          command: hookCommand,
        },
      ],
    });
  // Configure SessionEnd hook to track session exit
  settings.hooks.SessionEnd = Array.isArray(settings.hooks.SessionEnd)
    ? settings.hooks.SessionEnd
    : [];

  const endHookCommand = `node "${ENSURE_PATH}" --end`;
  const existingEndGroup = settings.hooks.SessionEnd.find((g) =>
    g?.hooks?.some((h) => h?.command?.includes('ensure.mjs'))
  );

  if (existingEndGroup) {
    const existingEndHook = existingEndGroup.hooks.find((h) => h?.command?.includes('ensure.mjs'));
    existingEndHook.command = endHookCommand;
  } else {
    settings.hooks.SessionEnd.push({
      hooks: [
        {
          type: 'command',
          command: endHookCommand,
        },
      ],
    });
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  console.log(`✓ Updated ${settingsPath}`);
  console.log('✓ Auto-start hook registered (proxy starts automatically with `claude`)');
  console.log('✓ Inactivity auto-shutdown enabled (shuts down after 15 min of idle)\n');
  console.log('Setup complete! You can now start Claude Code by typing `claude`.');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
