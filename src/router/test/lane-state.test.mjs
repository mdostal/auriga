import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgentLanesFile, readLaneState, withLaneState } from '../lib/lane-state.mjs';
import { agentIdSet, chooseAgentForProject, detectAssignedIdle } from '../lib/core.mjs';
import { loadTenantConfigs } from '../lib/tenant-configs.mjs';
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

test('PANT-1278: the shipped map is keyed by agent ID; a name entry wins over an ID entry', () => {
  const c = withLaneState({ ...cfg, AGENT_LANES: { 'id-b': 'account-two' }, AGENTS: { ...cfg.AGENTS, b: { ...cfg.AGENTS.b, id: 'id-b' } } },
    { lanes: [{ lane_id: 'account-two', status: 'degraded', reason: 'reset at 21:03Z' }], error: null });
  assert.equal(c.AGENTS.b.available, false);
  assert.equal(c.AGENTS.b.laneId, 'account-two');
  assert.match(c.AGENTS.b.availabilityReason, /^heimdall:account-two:/);
  const nameWins = withLaneState({ ...cfg, AGENT_LANES: { b: 'account-one', 'id-b': 'account-two' }, AGENTS: { ...cfg.AGENTS, b: { ...cfg.AGENTS.b, id: 'id-b' } } },
    { lanes: [{ lane_id: 'account-two', status: 'degraded' }, { lane_id: 'account-one', status: 'up' }], error: null });
  assert.equal(nameWins.AGENTS.b.laneId, 'account-one');
  assert.equal(nameWins.AGENTS.b.available, true);
});

test('PANT-1278: loadAgentLanesFile flattens lanes to agentId->lane and fails soft', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-'));
  const f = path.join(dir, 'lanes.json');
  fs.writeFileSync(f, JSON.stringify({ _comment: 'x', lanes: { codex: { 'id-1': 'Codex' }, gemini: { 'id-2': 'rev' } } }));
  assert.deepEqual(loadAgentLanesFile(f), { 'id-1': 'codex', 'id-2': 'gemini' });
  const warn = console.warn; console.warn = () => {};
  try { assert.deepEqual(loadAgentLanesFile(path.join(dir, 'missing.json')), {}); } finally { console.warn = warn; }
  const shipped = loadAgentLanesFile();
  assert.equal(shipped['032cbfa8-e65c-4e5a-b4c9-e51120d382bc'], 'codex'); // flayr-build-codex
  assert.equal(shipped['84c1c48c-1425-49d9-8dc4-e841f2034654'], 'claude@ffevents'); // auriga-build
  assert.equal(shipped['4912c5e8-9275-493b-a465-c30ffd7ebac3'], 'gemini');
});

const IDLE_CFG = {
  AGENTS: { codex: { id: 'C', runtime: 'codex', maxInflight: 3 }, claude: { id: 'L', runtime: 'claude', maxInflight: 3 } },
  AGENT_LANES: { C: 'codex', L: 'claude@x' }, PROJECT_NAMES: {}, RUNTIME_CAP: {},
  CAPS: { assignedIdleStaleMs: 10 * 60 * 1000, zombieStaleMs: 20 * 60 * 1000 }, HUMAN_NAMES: [],
};
const NOW = 1_700_000_000_000;
const handBack = (id, assignee) => ({ id, identifier: id, status: 'todo', assignee_id: assignee, parent_issue_id: 'E',
  title: 'changes requested', created_at: new Date(NOW - 60_000).toISOString(), updated_at: new Date(NOW).toISOString() });

test('PANT-1278: a send-back assigned to a builder on an unavailable lane is unassigned at once', () => {
  const c = withLaneState(IDLE_CFG, { lanes: [{ lane_id: 'codex', status: 'degraded', reason: 'reset 2026-11-19T21:03Z' }, { lane_id: 'claude@x', status: 'up' }], error: null });
  const actions = detectAssignedIdle([handBack('T-1', 'C'), handBack('T-2', 'L')], {}, c, agentIdSet(c.AGENTS), NOW);
  assert.equal(actions.length, 1, 'only the codex ticket; the fresh claude ticket is not stale yet');
  assert.equal(actions[0].identifier, 'T-1');
  assert.equal(actions[0].action, 'unassign');
  assert.equal(actions[0].reason, 'assignee-lane-unavailable');
  assert.match(actions[0].availabilityReason, /^heimdall:codex:/);
});

test('PANT-1278: running work on an unavailable lane is left alone', () => {
  const c = withLaneState(IDLE_CFG, { lanes: [{ lane_id: 'codex', status: 'degraded' }], error: null });
  const runs = { 'T-1': [{ status: 'running', started_at: new Date(NOW - 30_000).toISOString(), created_at: new Date(NOW - 30_000).toISOString() }] };
  assert.deepEqual(detectAssignedIdle([handBack('T-1', 'C')], runs, c, agentIdSet(c.AGENTS), NOW), []);
});

test('PANT-1278: a Heimdall outage does not unassign anything', () => {
  const c = withLaneState(IDLE_CFG, { lanes: [], error: 'connection refused' });
  assert.deepEqual(detectAssignedIdle([handBack('T-1', 'C')], {}, c, agentIdSet(c.AGENTS), NOW), []);
});

test('PANT-1278: a tenant AGENT_LANES merges over the shipped base map instead of replacing it', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tenants: [
    { tenant_id: 't1', config: { AGENT_LANES: { 'id-2': 'claude@t1' } } },
    { tenant_id: 't2', config: {} },
  ] }) });
  const out = await loadTenantConfigs({ pantheonApiBaseUrl: 'http://x', baseCfg: { AGENT_LANES: { 'id-1': 'codex', 'id-2': 'gemini' } }, fetchImpl });
  assert.deepEqual(out[0].cfg.AGENT_LANES, { 'id-1': 'codex', 'id-2': 'claude@t1' });
  assert.deepEqual(out[1].cfg.AGENT_LANES, { 'id-1': 'codex', 'id-2': 'gemini' });
});
