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
