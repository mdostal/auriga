// PANT-1327 (heimdall#142, Auriga side): a per-task model override at dispatch
// from Heimdall's route verdict, and a hold on a `queue` verdict. The planner
// is unit-tested first; then the three done-when cases drive the REAL cycle()
// against mock adapters (same shape as router-cycle.e2e.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycle } from '../auriga-router.mjs';
import * as cfg from '../lib/config.mjs';
import { dispatchEligible } from '../lib/dispatch-guards.mjs';
import { heimdallHoldUntilMs, planDispatchFromRoute } from '../lib/model-override.mjs';
import { createLogSink } from './support/mock-mca.mjs';
import { linkedOpenPrs } from './support/linked-pr.mjs';

const OPUS = 'claude-opus-5-5';
const FABLE = 'claude-fable-5-2';
const LANE = 'claude@fixture';
const NOW = Date.parse('2026-11-24T12:00:00Z');
const NOOP_SLEEP = async () => {};

function swapVerdict(overrides = {}) {
  return {
    decision_id: 'dec-1', verdict: 'route', chosen_lane: LANE, resets_at: null,
    model: OPUS, preferred_model: FABLE,
    model_swap: { lane_id: LANE, preferred_model: FABLE, model: OPUS, level: 'high', cause: { kind: 'limit', reason: 'fable weekly window 97% used', resets_at: '2026-11-25T00:00:00Z' } },
    ...overrides,
  };
}
const plainVerdict = (overrides = {}) => ({ decision_id: 'dec-2', verdict: 'route', chosen_lane: LANE, resets_at: null, model: FABLE, preferred_model: FABLE, model_swap: null, ...overrides });
const queueVerdict = (resetsAt) => ({ decision_id: null, verdict: 'queue', chosen_lane: null, resets_at: resetsAt, model: null, preferred_model: null, model_swap: null, allowed_levels: ['high'] });

// ---- planner ---------------------------------------------------------------

test('planner: a swap Heimdall named for the agent\'s own lane is an override carrying its reason', () => {
  const plan = planDispatchFromRoute(swapVerdict(), { executedLane: LANE, preferredModel: FABLE, now: NOW });
  assert.deepEqual(plan, { kind: 'override', model: OPUS, preferredModel: FABLE, lane: LANE, reason: 'limit: fable weekly window 97% used: resets 2026-11-25T00:00:00Z' });
});

test('planner: model differing from preferred_model is an override even without a model_swap object', () => {
  const plan = planDispatchFromRoute(swapVerdict({ model_swap: null }), { executedLane: LANE, now: NOW });
  assert.equal(plan.kind, 'override');
  assert.equal(plan.model, OPUS);
  assert.equal(plan.preferredModel, FABLE);
});

test('planner: everything else dispatches unchanged', () => {
  const ctx = { executedLane: LANE, preferredModel: FABLE, now: NOW };
  const cases = {
    'no verdict (heimdall unreachable)': null,
    'model equals the preference (Pantheon fills `model` on every answer)': plainVerdict(),
    'bare model, no preference, no swap': plainVerdict({ preferred_model: null }),
    'no model at all': plainVerdict({ model: null, preferred_model: null }),
    'verdict for another lane': swapVerdict({ chosen_lane: 'gemini' }),
    'no_route': swapVerdict({ verdict: 'no_route' }),
    'swap names a different model than the verdict': swapVerdict({ model_swap: { ...swapVerdict().model_swap, model: 'claude-haiku-5-5' } }),
    'queue without a reset time': queueVerdict(null),
    'queue whose reset already passed': queueVerdict('2026-11-24T11:00:00Z'),
  };
  for (const [name, route] of Object.entries(cases)) {
    assert.deepEqual(planDispatchFromRoute(route, ctx), { kind: 'default' }, name);
  }
  // No executed lane configured: the verdict can't be matched to this agent.
  assert.deepEqual(planDispatchFromRoute(swapVerdict(), { executedLane: null, now: NOW }), { kind: 'default' });
});

test('planner: never returns a model the verdict did not name', () => {
  // Even when the agent row prefers something else, the override is the verdict's own model.
  const plan = planDispatchFromRoute(swapVerdict(), { executedLane: LANE, preferredModel: 'claude-sonnet-5-5', now: NOW });
  assert.equal(plan.model, OPUS);
  // And the row's preferred model being what Heimdall named is no override at all.
  assert.deepEqual(planDispatchFromRoute(swapVerdict(), { executedLane: LANE, preferredModel: OPUS, now: NOW }), { kind: 'default' });
});

test('planner: a queue verdict with a future resets_at holds until then', () => {
  const plan = planDispatchFromRoute(queueVerdict('2026-11-24T15:30:00Z'), { executedLane: LANE, now: NOW });
  assert.equal(plan.kind, 'hold');
  assert.equal(plan.until, '2026-11-24T15:30:00.000Z');
  assert.match(plan.reason, /heimdall queue.*high.*2026-11-24T15:30:00\.000Z/);
});

test('guard: a recorded hold skips every pass until resets_at, then lets it through', () => {
  const issue = { identifier: 'PAN-1', metadata: { heimdall_queue_until: '2026-11-24T15:30:00.000Z' } };
  for (const pass of ['build', 'cascade-rerun', 'review', 'zombie-rerun']) {
    const r = dispatchEligible(issue, pass, { cfg, now: NOW });
    assert.equal(r.ok, false, pass);
    assert.match(r.reason, /^heimdall-queue-until 2026-11-24T15:30:00\.000Z$/);
  }
  assert.equal(dispatchEligible(issue, 'build', { cfg, now: Date.parse('2026-11-24T15:30:01Z') }).ok, true);
  assert.equal(heimdallHoldUntilMs(issue, NOW, { MODEL_OVERRIDE: { enabled: false } }), null, 'disabled in config: no hold');
});

// ---- the three done-when cases through cycle() ----------------------------

function projectId(name) {
  return Object.entries(cfg.PROJECT_NAMES).find(([, n]) => n === name)?.[0];
}

let seq = 9000;
function makeIssue(project) {
  const n = seq++;
  return { id: `id-${n}`, identifier: `PAN-${n}`, number: n, title: `story ${n}`, description: '', labels: [], status: 'todo', assignee_id: null, parent_issue_id: 'fake-parent', metadata: {}, project_id: project };
}

// One-agent lane whose agent row prefers Fable, mapped to Heimdall lane LANE.
function fixture() {
  const agent = cfg.DEFAULT_LANE[0];
  const project = projectId('Pantheon Core');
  const fixtureCfg = {
    ...cfg,
    PROJECT_LANE: { ...cfg.PROJECT_LANE, [project]: [agent] },
    AGENT_LANES: { [agent]: LANE },
    AGENTS: { ...cfg.AGENTS, [agent]: { ...cfg.AGENTS[agent], model: FABLE } },
  };
  return { agent, project, fixtureCfg };
}

function mockAdapters(board, agents, verdicts) {
  const calls = { assign: [], rerun: [], metadata: [], selectRoute: [] };
  const runs = {};
  const find = (identifier) => board.find((i) => i.identifier === identifier);
  const started = (identifier) => { runs[identifier] = [...(runs[identifier] || []), { status: 'in_progress', created_at: new Date().toISOString(), dispatched_at: new Date().toISOString() }]; };
  const backlog = {
    listAllProjectIds: () => [],
    listAllIssues: (projectIds) => board.filter((i) => projectIds.includes(i.project_id)),
    getIssueRuns: (identifier) => runs[identifier] || [],
    getIssuePullRequests: linkedOpenPrs,
    setIssueStatus: (identifier, status) => { const i = find(identifier); if (i) i.status = status; },
    commentOnIssue: () => {},
    setIssueMetadata: (identifier, metadataObj) => {
      calls.metadata.push({ identifier, metadataObj });
      const i = find(identifier);
      if (i) i.metadata = { ...i.metadata, ...metadataObj };
    },
  };
  const spawn = {
    selectRoute: (identifier, taskType, executedLane) => {
      calls.selectRoute.push({ identifier, taskType, executedLane });
      return verdicts.shift() ?? null;
    },
    assignIssue: (...args) => {
      const [identifier, agentName] = args;
      calls.assign.push({ identifier, agentName, args });
      const i = find(identifier);
      if (i) i.assignee_id = agents[agentName]?.id;
      started(identifier);
    },
    rerunIssue: (...args) => { calls.rerun.push({ identifier: args[0], args }); started(args[0]); },
    unassignIssue: () => {},
    describeLanes: () => ({}),
  };
  return { backlog, spawn, calls };
}

const laneUp = async () => ({ lanes: [{ lane_id: LANE, status: 'up' }], error: null });

test('done-when 1+2: a verdict naming Opus dispatches that task on Opus while the row stays Fable; the next verdict without an override dispatches on Fable again', async () => {
  const { agent, project, fixtureCfg } = fixture();
  const first = makeIssue(project);
  const board = [first];
  const verdicts = [swapVerdict()];
  const { backlog, spawn, calls } = mockAdapters(board, fixtureCfg.AGENTS, verdicts);
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP, readLaneState: laneUp, now: NOW });

  assert.equal(calls.assign.length, 1);
  assert.deepEqual(calls.assign[0].args, [first.identifier, agent, { model: OPUS }], 'this one task dispatches on Opus');
  const [ov] = log.byEvent('model_override');
  assert.ok(ov, 'the override is logged');
  assert.equal(ov.identifier, first.identifier);
  assert.equal(ov.agent, agent);
  assert.equal(ov.preferred_model, FABLE);
  assert.equal(ov.model, OPUS);
  assert.equal(ov.lane, LANE);
  assert.match(ov.reason, /fable weekly window 97% used/);
  assert.equal(fixtureCfg.AGENTS[agent].model, FABLE, 'the agent row still says Fable');
  assert.equal(cfg.AGENTS[agent].model, undefined, 'the shipped agent table is untouched');

  // Next cycle: a new task, a verdict without an override -> Fable (the agent's own model, no per-task model sent).
  first.status = 'done';
  const second = makeIssue(project);
  board.push(second);
  verdicts.push(plainVerdict());
  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP, readLaneState: laneUp, now: NOW + 60_000 });

  const secondAssign = calls.assign.filter((c) => c.identifier === second.identifier);
  assert.equal(secondAssign.length, 1);
  assert.deepEqual(secondAssign[0].args, [second.identifier, agent], 'no per-task model: dispatches on the row\'s Fable');
  assert.equal(log.byEvent('model_override').length, 1, 'no new override logged');
});

test('done-when 1: a forced rerun in the same cycle as the override keeps the overridden model', async () => {
  const { agent, project, fixtureCfg } = fixture();
  const issue = makeIssue(project);
  const { backlog, spawn, calls } = mockAdapters([issue], fixtureCfg.AGENTS, [swapVerdict()]);
  // The assign starts no run, so verifyAssignStarted forces a rerun.
  spawn.assignIssue = (...args) => { calls.assign.push({ identifier: args[0], agentName: args[1], args }); };
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP, readLaneState: laneUp, now: NOW });

  assert.deepEqual(calls.assign[0].args, [issue.identifier, agent, { model: OPUS }]);
  assert.equal(calls.rerun.length, 1);
  assert.deepEqual(calls.rerun[0].args, [issue.identifier, { model: OPUS }]);
});

test('done-when 3: a queue verdict holds the task until resets_at, then it dispatches', async () => {
  const { agent, project, fixtureCfg } = fixture();
  const issue = makeIssue(project);
  const resetsAt = '2026-11-24T15:30:00.000Z';
  const verdicts = [queueVerdict(resetsAt)];
  const { backlog, spawn, calls } = mockAdapters([issue], fixtureCfg.AGENTS, verdicts);
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP, readLaneState: laneUp, now: NOW });

  assert.equal(calls.assign.length, 0, 'not dispatched to fail');
  assert.equal(calls.rerun.length, 0);
  const [held] = log.byEvent('dispatch_held');
  assert.ok(held, 'the hold is logged');
  assert.equal(held.identifier, issue.identifier);
  assert.equal(held.until, resetsAt);
  assert.equal(issue.metadata.heimdall_queue_until, resetsAt, 'the hold is recorded on the issue');
  assert.match(issue.metadata.heimdall_queue_reason, /heimdall queue/);

  // Before resets_at: skipped without even asking Heimdall again.
  const asked = calls.selectRoute.length;
  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP, readLaneState: laneUp, now: Date.parse('2026-11-24T15:00:00Z') });
  assert.equal(calls.assign.length, 0, 'still held');
  assert.equal(calls.selectRoute.length, asked, 'held issues never reach dispatch');

  // After resets_at: dispatched normally, and the hold is cleared.
  verdicts.push(plainVerdict());
  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP, readLaneState: laneUp, now: Date.parse('2026-11-24T15:31:00Z') });
  assert.equal(calls.assign.length, 1);
  assert.deepEqual(calls.assign[0].args, [issue.identifier, agent]);
  assert.equal(issue.metadata.heimdall_queue_until, '', 'hold cleared on the dispatch that ends it');
});

test('MODEL_OVERRIDE.enabled=false: the verdict is ignored and dispatch is unchanged', async () => {
  const { agent, project, fixtureCfg } = fixture();
  const offCfg = { ...fixtureCfg, MODEL_OVERRIDE: { ...cfg.MODEL_OVERRIDE, enabled: false } };
  const a = makeIssue(project);
  const { backlog, spawn, calls } = mockAdapters([a], offCfg.AGENTS, [swapVerdict()]);
  const log = createLogSink();
  await cycle({ backlog, spawn, cfg: offCfg, log, sleep: NOOP_SLEEP, readLaneState: laneUp, now: NOW });
  assert.deepEqual(calls.assign[0].args, [a.identifier, agent]);
  assert.equal(log.byEvent('model_override').length, 0);
});
