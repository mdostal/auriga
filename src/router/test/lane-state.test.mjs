import test from 'node:test';
import assert from 'node:assert/strict';
import { readLaneState, withLaneState } from '../lib/lane-state.mjs';
import { chooseAgentForProject } from '../lib/core.mjs';
import { dispatchEligible } from '../lib/dispatch-guards.mjs';

const cfg = {
  AGENTS: { a: { id: 'a', runtime: 'r1', maxInflight: 5 }, b: { id: 'b', runtime: 'r2', maxInflight: 5 }, unmapped: {} },
  AGENT_LANES: { a: 'account-one', b: 'account-two' },
  PROJECT_LANE: { p: ['a', 'b'] }, RUNTIME_CAP: {},
};
const project = { perAgent: {}, perRuntime: {}, perAgentCycle: {} };
function choose(c) { return chooseAgentForProject('p', c, {}, {}, project); }

test('disabled and limited accounts fall through within the configured lane only', () => {
  const c = withLaneState(cfg, { lanes: [{ lane_id: 'account-one', status: 'out_of_credit', reason: 'weekly limit' }], error: null });
  assert.equal(choose(c), 'b');
  assert.match(c.AGENTS.a.availabilityReason, /weekly limit/);
  assert.equal(cfg.AGENTS.a.available, undefined);
  assert.equal(c.AGENTS.unmapped.available, true);
  assert.equal(dispatchEligible({}, 'assigned-idle', { cfg: c, agent: 'a' }).ok, false);
  const all = withLaneState(cfg, { lanes: [{ lane_id: 'account-one', effective_enabled: false }, { lane_id: 'account-two', status: 'down' }], error: null });
  assert.equal(choose(all), null);
});

test('effective_enabled takes precedence in either deployment order', () => {
  for (const [lane, expected] of [
    [{ status: 'up', effective_enabled: false }, false],
    [{ status: 'down', effective_enabled: true }, true],
    [{ status: 'up' }, true], [{ status: 'degraded' }, false],
  ]) {
    const c = withLaneState(cfg, { lanes: [{ lane_id: 'account-one', ...lane }], error: null });
    assert.equal(c.AGENTS.a.available, expected);
  }
});

test('outage is bounded, fail open and does not retain previous lane state', async () => {
  const state = await readLaneState({ fetchImpl: async (_url, options) => {
    assert.ok(options.signal);
    throw new Error('connection refused');
  } });
  assert.match(state.error, /connection refused/);
  assert.equal(choose(withLaneState(cfg, state)), 'a');
  assert.equal((await readLaneState({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })).lanes.length, 0);
});

test('archived agents never become eligible through lane health', () => {
  const c = withLaneState({ ...cfg, AGENTS: { ...cfg.AGENTS, a: { ...cfg.AGENTS.a, archived: true } } }, { lanes: [], error: null });
  assert.equal(choose(c), 'b');
});
