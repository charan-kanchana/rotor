import assert from 'node:assert';
import { load, newId, statsFor, logEvent } from '../server/lib/config.mjs';
import { mapModel } from '../server/lib/proxy.mjs';

const cfg = load();
assert.ok(cfg, 'config should load');
assert.ok(Array.isArray(cfg.providers), 'providers should be an array');
assert.ok(Array.isArray(cfg.events), 'events should be an array');

const id = newId();
assert.equal(typeof id, 'string');
assert.ok(id.length > 5);

const s = statsFor(cfg, 'test-prov');
assert.equal(s.requests, 0);

logEvent(cfg, 'self-check event');
assert.ok(cfg.events.some(e => e.msg === 'self-check event'));

const p = {
  id: 'test',
  name: 'test',
  models: {
    opus: 'my-custom-opus',
    sonnet: 'my-custom-sonnet',
  },
};

assert.equal(mapModel(p, 'rotor:opus'), 'my-custom-opus');
assert.equal(mapModel(p, 'rotor:sonnet'), 'my-custom-sonnet');
assert.equal(mapModel(p, 'rotor:haiku'), 'my-custom-sonnet', 'haiku should fallback to sonnet');
assert.equal(mapModel(p, 'rotor:fable'), 'my-custom-sonnet', 'fable should fallback to sonnet when unassigned');
const pWithFable = { ...p, models: { ...p.models, fable: 'my-custom-fable' } };
assert.equal(mapModel(pWithFable, 'rotor:fable'), 'my-custom-fable');
assert.equal(mapModel(pWithFable, 'claude-fable-5-1'), 'my-custom-fable');
assert.equal(mapModel(p, 'rotor:sonnet[1m]'), 'my-custom-sonnet', 'bracket suffix should be stripped');
assert.equal(mapModel(p, 'claude-3-5-sonnet-20241022'), 'my-custom-sonnet', 'standard sonnet should map to sonnet slot');
assert.equal(mapModel(p, 'claude-3-opus-20240229'), 'my-custom-opus', 'standard opus should map to opus slot');
assert.equal(mapModel(p, 'other-model'), 'other-model');

// Session liveness & cleanup check
let myPidAlive = false;
try {
  process.kill(process.pid, 0);
  myPidAlive = true;
} catch {}
assert.ok(myPidAlive, 'current process PID must be reported as alive');

let deadPidAlive = false;
try {
  process.kill(999999, 0);
  deadPidAlive = true;
} catch {}
assert.strictEqual(deadPidAlive, false, 'non-existent PID must not be reported as alive');

const simSessions = new Map([
  ['s1', { pid: process.pid }],
  ['s2', { pid: 999999 }]
]);
for (const [sid, sess] of simSessions.entries()) {
  try {
    process.kill(sess.pid, 0);
  } catch {
    simSessions.delete(sid);
  }
}
assert.strictEqual(simSessions.size, 1, 'dead session should be cleaned up');
assert.ok(simSessions.has('s1'), 'live session should be preserved');

// OpenRouter auth & endpoint reachability checks
import { checkAuth, deepCheck } from '../server/lib/health.mjs';

const orDummy = await checkAuth({
  id: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'dummy-invalid-key-testing',
  authStyle: 'bearer',
});
assert.strictEqual(orDummy.ok, false, 'OpenRouter with dummy key must fail auth check');
assert.ok(orDummy.error?.includes('OpenRouter') || orDummy.error?.includes('Authentication'), 'Error message should report auth failure');

const unreachable = await checkAuth({
  id: 'bad-endpoint',
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'key',
});
assert.strictEqual(unreachable.ok, false, 'Unreachable endpoint must fail check');

const llm7Probe = await checkAuth({
  id: 'llm7',
  baseUrl: 'https://api.llm7.io/v1',
  apiKey: 'dummy-key',
  protocol: 'anthropic',
});
assert.strictEqual(llm7Probe.ok, false, 'llm7 with Anthropic protocol and unavailable model must fail probe');

console.log('All rotor self-checks passed!');
