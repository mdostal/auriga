// PAN-8244: assignedQueued dead-zone — a story sits assigned+todo but never
// executes, even across many router scans. These tests pin the expected
// self-heal behavior end-to-end: detect -> select up to real concurrency
// capacity -> report a reason for anything left behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';

const CFG = {
  AGENTS: {
    'auriga-dev': { id: 'A', runtime: 'codex', maxInflight: 3 },
    'heimdall-dev-codex': { id: 'HC', runtime: 'codex', maxInflight: 3 },
    'minerva-dev': { id: 'M', runtime: 'opencode', maxInflight: 3 },
    'votum-dev': { id: 'V', runtime: 'claude', maxInflight: 3 },
  },
  RUNTIME_CAP: { codex: 4, opencode: 3, claude: 2 },
  PROJECT_NAMES: {},
  CAPS: {
    assignedIdleStaleMs: 10 * 60 * 1000,
    assignedIdlePerCycle: 10,
    zombieStaleMs: 20 * 60 * 1000,
  },
  HUMAN_NAMES: ['mathew', 'dostal'],
};

const NOW = 1_700_000_000_000;
const OLD = NOW - 60 * 60 * 1000; // 1h idle — well past the 10-min stale threshold

const assignedTodo = (id, assigneeId, updatedAt = OLD, title = 'work') => ({
  id, identifier: id, status: 'todo', assignee_id: assigneeId, updated_at: new Date(updatedAt).toISOString(), title,
  parent_issue_id: 'parent-seed', // sub-tasks, not seeds — detectAssignedIdle is for build-agent work
});

test('AC1: a single assignedQueued item is detected as a recovery action once stale', () => {
  const issues = [assignedTodo('PAN-1', 'A')];
  const actions = core.detectAssignedIdle(issues, {}, CFG, core.agentIdSet(CFG.AGENTS), NOW);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].identifier, 'PAN-1');
  assert.equal(actions[0].action, 'start');
});

test('AC2: multiple assignedQueued items for the same agent all get selected up to its concurrency limit', () => {
  // auriga-dev has maxInflight 3 and zero current inflight -> all 3 stuck
  // items should be selected for recovery, not just one.
  const issues = [
    assignedTodo('PAN-1', 'A'),
    assignedTodo('PAN-2', 'A'),
    assignedTodo('PAN-3', 'A'),
  ];
  const actions = core.detectAssignedIdle(issues, {}, CFG, core.agentIdSet(CFG.AGENTS), NOW);
  const { selected, skipped } = core.limitAssignedIdleRecoveries(actions, CFG, {
    agents: CFG.AGENTS,
    inflight: {},
    now: NOW,
  });
  assert.equal(selected.length, 3, `expected all 3 eligible items to be selected, got ${selected.length}`);
  assert.equal(skipped.length, 0);
});

test('AC2b: recovery selection never exceeds the agent maxInflight, even with more idle items than capacity', () => {
  const issues = Array.from({ length: 5 }, (_, i) => assignedTodo('PAN-' + i, 'A'));
  const actions = core.detectAssignedIdle(issues, {}, CFG, core.agentIdSet(CFG.AGENTS), NOW);
  const { selected, skipped } = core.limitAssignedIdleRecoveries(actions, CFG, {
    agents: CFG.AGENTS,
    inflight: {},
    now: NOW,
  });
  assert.equal(selected.length, 3, 'auriga-dev maxInflight is 3');
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((s) => s.skipReason === 'at-capacity'));
});

test('AC3: token/capacity constraints block recovery until inflight room frees up', () => {
  const issues = [assignedTodo('PAN-1', 'A')];
  const actions = core.detectAssignedIdle(issues, {}, CFG, core.agentIdSet(CFG.AGENTS), NOW);

  // auriga-dev already fully saturated by real running work -> no room this cycle.
  const saturated = core.limitAssignedIdleRecoveries(actions, CFG, {
    agents: CFG.AGENTS,
    inflight: { 'auriga-dev': 3 },
    now: NOW,
  });
  assert.equal(saturated.selected.length, 0);
  assert.equal(saturated.skipped[0].skipReason, 'at-capacity');

  // Tokens/capacity free up -> the same item is now eligible.
  const freed = core.limitAssignedIdleRecoveries(actions, CFG, {
    agents: CFG.AGENTS,
    inflight: { 'auriga-dev': 2 },
    now: NOW,
  });
  assert.equal(freed.selected.length, 1);
  assert.equal(freed.selected[0].identifier, 'PAN-1');
});

test('AC3b: a shared runtime cap blocks recovery even when the individual agent has room', () => {
  // auriga-dev and heimdall-dev-codex share the codex runtime (cap 4).
  const issues = [assignedTodo('PAN-1', 'A')];
  const actions = core.detectAssignedIdle(issues, {}, CFG, core.agentIdSet(CFG.AGENTS), NOW);
  const result = core.limitAssignedIdleRecoveries(actions, CFG, {
    agents: CFG.AGENTS,
    inflight: { 'auriga-dev': 1, 'heimdall-dev-codex': 3 }, // codex runtime already at cap 4
    now: NOW,
  });
  assert.equal(result.selected.length, 0);
  assert.equal(result.skipped[0].skipReason, 'at-capacity');
});

test('AC4: a rate-limited runtime is reported with its own diagnostic reason, distinct from capacity', () => {
  const issues = [assignedTodo('PAN-1', 'V')]; // votum-dev -> claude runtime
  const actions = core.detectAssignedIdle(issues, {}, CFG, core.agentIdSet(CFG.AGENTS), NOW);
  const result = core.limitAssignedIdleRecoveries(actions, CFG, {
    agents: CFG.AGENTS,
    inflight: {},
    blockedRuntimes: new Set(['claude']),
    now: NOW,
  });
  assert.equal(result.selected.length, 0);
  assert.equal(result.skipped[0].skipReason, 'rate-limited');
});

test('AC4a: an offline runtime is reported distinctly from capacity and rate limits', () => {
  const agents = {
    ...CFG.AGENTS,
    'auriga-dev': { ...CFG.AGENTS['auriga-dev'], available: false, runtimeId: 'offline-codex-runtime' },
  };
  const issues = [assignedTodo('PAN-1', 'A')];
  const actions = core.detectAssignedIdle(issues, {}, CFG, core.agentIdSet(agents), NOW);
  const result = core.limitAssignedIdleRecoveries(actions, CFG, {
    agents,
    inflight: {},
    now: NOW,
  });
  assert.equal(result.selected.length, 0);
  assert.equal(result.skipped[0].skipReason, 'runtime-offline');
  assert.equal(result.skipped[0].runtimeId, 'offline-codex-runtime');
});

test('AC4b: an item still within the stale window is a genuine queue, not a stuck dead-zone', () => {
  const issues = [assignedTodo('PAN-1', 'A', NOW - 30 * 1000)]; // 30s old, staleMs is 10min
  const actions = core.detectAssignedIdle(issues, {}, CFG, core.agentIdSet(CFG.AGENTS), NOW);
  assert.equal(actions.length, 0, 'a freshly-assigned todo is not yet a dead-zone candidate');
});

test('AC4c: per-cycle cap truncation is reported with its own reason so it is distinguishable from capacity/rate-limit', () => {
  const issues = [
    assignedTodo('PAN-1', 'A', OLD),
    assignedTodo('PAN-2', 'HC', OLD),
  ];
  const cfg = { ...CFG, CAPS: { ...CFG.CAPS, assignedIdlePerCycle: 1 } };
  const actions = core.detectAssignedIdle(issues, {}, cfg, core.agentIdSet(CFG.AGENTS), NOW);
  const result = core.limitAssignedIdleRecoveries(actions, cfg, { agents: CFG.AGENTS, inflight: {}, now: NOW });
  assert.equal(result.selected.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].skipReason, 'per-cycle-cap');
});

test('PANT-342: stale runtimeInflight must not override inflight-derived cap — omit it so the function recomputes', () => {
  // Scenario: cascade/zombie added auriga-dev to codex this cycle, bumping inflight to
  // { 'auriga-dev': 1, 'heimdall-dev-codex': 3 } → codex runtime at cap (4).
  // The cycle-start runtimeInflight snapshot only saw 3 codex agents.
  // Passing the stale snapshot would let recovery fire one more codex agent (wrong).
  // Omitting it causes the function to recompute codex=4 from inflight and block it.
  const issues = [assignedTodo('PAN-1', 'A')]; // auriga-dev → codex
  const actions = core.detectAssignedIdle(issues, {}, CFG, core.agentIdSet(CFG.AGENTS), NOW);

  // Stale runtimeInflight (cycle-start snapshot, doesn't know cascade added HC):
  const staleRuntimeInflight = { codex: 3, opencode: 0, claude: 0 };
  // Updated inflight (reflects cascade/zombie: HC now running 3):
  const updatedInflight = { 'auriga-dev': 0, 'heimdall-dev-codex': 3 };

  // Passing stale runtimeInflight would incorrectly allow recovery (codex sees 3 < 4):
  const withStale = core.limitAssignedIdleRecoveries(actions, CFG, {
    agents: CFG.AGENTS,
    inflight: updatedInflight,
    runtimeInflight: staleRuntimeInflight,
    now: NOW,
  });
  assert.equal(withStale.selected.length, 1, 'stale snapshot incorrectly allows recovery (regression)');

  // Omitting runtimeInflight causes recompute from inflight → codex=3, still under cap,
  // but auriga-dev has 0 in-flight so it IS eligible. Now add auriga-dev's run to inflight
  // to make codex hit exactly 4:
  const atCapInflight = { 'auriga-dev': 1, 'heimdall-dev-codex': 3 };
  const blocked = core.limitAssignedIdleRecoveries(actions, CFG, {
    agents: CFG.AGENTS,
    inflight: atCapInflight,
    now: NOW,
  });
  assert.equal(blocked.selected.length, 0, 'recomputed runtimeInflight correctly blocks recovery at codex cap');
  assert.equal(blocked.skipped[0].skipReason, 'at-capacity');
});

test('PANT-462: per-cycle-per-agent cap is enforced within idle-recovery pass — agent with N > cap idle issues gets at most cap dispatches', () => {
  // 4 idle issues for auriga-dev, but perCyclePerAgent = 2
  const issues = Array.from({ length: 4 }, (_, i) => assignedTodo('PAN-' + i, 'A'));
  const cfg = { ...CFG, CAPS: { ...CFG.CAPS, perCyclePerAgent: 2 } };
  const actions = core.detectAssignedIdle(issues, {}, cfg, core.agentIdSet(cfg.AGENTS), NOW);
  const { selected, skipped } = core.limitAssignedIdleRecoveries(actions, cfg, {
    agents: cfg.AGENTS,
    inflight: {},
    now: NOW,
  });
  assert.equal(selected.length, 2, 'per-cycle-per-agent cap of 2 must be respected');
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((s) => s.skipReason === 'per-cycle-per-agent-cap'));
});

test('PANT-462: per-cycle-per-agent cap applies per-agent — different agents each get at most cap dispatches', () => {
  // 3 idle issues for auriga-dev (id A) and 3 for minerva-dev (id M, opencode runtime)
  // Using different runtimes avoids runtime-cap interference, so all skips are per-cycle-per-agent-cap.
  const issues = [
    assignedTodo('PAN-A1', 'A'), assignedTodo('PAN-A2', 'A'), assignedTodo('PAN-A3', 'A'),
    assignedTodo('PAN-M1', 'M'), assignedTodo('PAN-M2', 'M'), assignedTodo('PAN-M3', 'M'),
  ];
  const cfg = { ...CFG, CAPS: { ...CFG.CAPS, perCyclePerAgent: 2, assignedIdlePerCycle: 10 } };
  const actions = core.detectAssignedIdle(issues, {}, cfg, core.agentIdSet(cfg.AGENTS), NOW);
  const { selected, skipped } = core.limitAssignedIdleRecoveries(actions, cfg, {
    agents: cfg.AGENTS,
    inflight: {},
    now: NOW,
  });
  assert.equal(selected.length, 4, 'two agents × cap 2 = 4 total selected');
  assert.equal(skipped.length, 2);
  const aSelected = selected.filter((s) => s.agent === 'auriga-dev').length;
  const mSelected = selected.filter((s) => s.agent === 'minerva-dev').length;
  assert.equal(aSelected, 2);
  assert.equal(mSelected, 2);
  assert.ok(skipped.every((s) => s.skipReason === 'per-cycle-per-agent-cap'));
});

test('PANT-488: detectAssignedIdle skips agent-parked issues (isAgentParked guard)', () => {
  // A todo+assigned issue with metadata.blocked_reason set must never be re-dispatched.
  const parked = {
    ...assignedTodo('PAN-99', 'A'),
    metadata: { blocked_reason: 'Waiting for human review of edge-case handling' },
  };
  const actions = core.detectAssignedIdle([parked], {}, CFG, core.agentIdSet(CFG.AGENTS), NOW);
  assert.equal(actions.length, 0, 'agent-parked issue must be excluded from idle recovery');
});


test('PANT-643: detectAssignedIdle does NOT skip seed issues — rerunIssue re-enqueues the current agent, never re-routes to build', () => {
  // detectAssignedIdle calls spawn.rerunIssue, which re-enqueues the CURRENT assignment.
  // A seed assigned to minerva-dev must be recoverable: skipping it leaves it permanently
  // stranded (PANT-643). The isSeed guard was removed because the semantics here are safe:
  // rerun never re-routes to a build lane; it fires against whoever is already assigned.
  const seed = { ...assignedTodo('PAN-seed', 'M'), labels: ['idea'], parent_issue_id: null };
  const nonSeed = assignedTodo('PAN-child', 'M'); // has parent_issue_id → structural non-seed
  const allIssues = [seed, nonSeed];
  const actions = core.detectAssignedIdle(allIssues, {}, CFG, core.agentIdSet(CFG.AGENTS), NOW, allIssues);
  assert.equal(actions.length, 2, 'PANT-643: both seed and non-seed must be detected — rerunIssue is safe for both');
  assert.ok(actions.some((a) => a.identifier === 'PAN-seed'), 'explicitly-labelled seed must be recovered');
  assert.ok(actions.some((a) => a.identifier === 'PAN-child'), 'non-seed child must still be detected');
});

test('oldest-idle-first: recovery prioritizes the longest-stuck items when capacity is scarce', () => {
  const issues = [
    assignedTodo('PAN-recent', 'A', NOW - 15 * 60 * 1000),
    assignedTodo('PAN-oldest', 'A', NOW - 3 * 60 * 60 * 1000),
    assignedTodo('PAN-mid', 'A', NOW - 30 * 60 * 1000),
  ];
  const actions = core.detectAssignedIdle(issues, {}, CFG, core.agentIdSet(CFG.AGENTS), NOW);
  const cfg = { ...CFG, AGENTS: { ...CFG.AGENTS, 'auriga-dev': { ...CFG.AGENTS['auriga-dev'], maxInflight: 1 } } };
  const result = core.limitAssignedIdleRecoveries(actions, cfg, { agents: cfg.AGENTS, inflight: {}, now: NOW });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].identifier, 'PAN-oldest');
});
