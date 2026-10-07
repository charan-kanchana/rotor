import assert from 'node:assert';

function upsertHook(hookArray, matchCommand, newCommand, extraGroupProps) {
  const existingGroup = hookArray.find((g) =>
    g?.hooks?.some((h) => typeof h?.command === 'string' && h.command.includes(matchCommand))
  );
  if (existingGroup) {
    const existingHook = existingGroup.hooks.find((h) => h?.command?.includes(matchCommand));
    if (existingHook) existingHook.command = newCommand;
  } else {
    hookArray.push({ ...(extraGroupProps || {}), hooks: [{ type: 'command', command: newCommand }] });
  }
}

const fake = {
  env: { MY_EXISTING_VAR: 'keep-me', EDITOR: 'vim' },
  hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-existing-start' }] }],
    SessionEnd:   [{ hooks: [{ type: 'command', command: 'echo user-existing-end' }] }],
    PreToolUse:   [{ hooks: [{ type: 'command', command: 'echo user-pretool' }] }],
  },
  customSetting: 'do-not-touch',
};

const settings = JSON.parse(JSON.stringify(fake));
settings.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8787';
settings.env.ANTHROPIC_AUTH_TOKEN = 'rotor-local';
settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'rotor:opus';
settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'rotor:fable';
settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'rotor:sonnet';
settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'rotor:haiku';
settings.hooks.SessionStart = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
settings.hooks.SessionEnd   = Array.isArray(settings.hooks.SessionEnd)   ? settings.hooks.SessionEnd   : [];
upsertHook(settings.hooks.SessionStart, 'ensure.mjs', 'node "/path/to/ensure.mjs"', { matcher: '^startup$' });
upsertHook(settings.hooks.SessionEnd,   'ensure.mjs', 'node "/path/to/ensure.mjs" --end');

// Existing env keys untouched
assert.strictEqual(settings.env.MY_EXISTING_VAR, 'keep-me', 'MY_EXISTING_VAR must be preserved');
assert.strictEqual(settings.env.EDITOR, 'vim', 'EDITOR must be preserved');
// Arbitrary top-level keys untouched
assert.strictEqual(settings.customSetting, 'do-not-touch', 'customSetting must be preserved');
// User's original SessionStart hook still there
assert.ok(
  settings.hooks.SessionStart.some(g => g.hooks.some(h => h.command === 'echo user-existing-start')),
  'User SessionStart hook must be preserved'
);
// Rotor SessionStart hook added alongside
assert.ok(
  settings.hooks.SessionStart.some(g => g.hooks.some(h => h.command.includes('ensure.mjs') && !h.command.includes('--end'))),
  'Rotor SessionStart hook must be added'
);
// User's original SessionEnd hook still there
assert.ok(
  settings.hooks.SessionEnd.some(g => g.hooks.some(h => h.command === 'echo user-existing-end')),
  'User SessionEnd hook must be preserved'
);
// Rotor SessionEnd hook added alongside
assert.ok(
  settings.hooks.SessionEnd.some(g => g.hooks.some(h => h.command.includes('ensure.mjs') && h.command.includes('--end'))),
  'Rotor SessionEnd hook must be added'
);
// Unrelated hook type completely untouched
assert.ok(
  settings.hooks.PreToolUse?.some(g => g.hooks.some(h => h.command === 'echo user-pretool')),
  'PreToolUse hook must be preserved'
);

// Re-run upsert (simulate running setup twice) — must not duplicate entries
upsertHook(settings.hooks.SessionStart, 'ensure.mjs', 'node "/path/to/ensure.mjs"', { matcher: '^startup$' });
upsertHook(settings.hooks.SessionEnd,   'ensure.mjs', 'node "/path/to/ensure.mjs" --end');
const rotorStartEntries = settings.hooks.SessionStart.filter(g => g.hooks.some(h => h.command.includes('ensure.mjs'))).length;
const rotorEndEntries   = settings.hooks.SessionEnd.filter(g => g.hooks.some(h => h.command.includes('ensure.mjs'))).length;
assert.strictEqual(rotorStartEntries, 1, 'Running setup twice must not duplicate SessionStart hook');
assert.strictEqual(rotorEndEntries,   1, 'Running setup twice must not duplicate SessionEnd hook');

console.log('All install.mjs hook preservation checks passed!');
