// dispatchEligible() unit tests (PANT-815). The end-to-end coverage of every
// pass x guard is dispatch-guard-matrix.test.mjs; this pins the pure function's
// own contract: guard order, stop vs skip, and which passes the seed guard covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchEligible, isRateLimitError } from '../lib/dispatch-guards.mjs';
import { PLANNING_AGENT } from '../lib/core.mjs';

const issue = (o = {}) => ({ identifier: 'X-1', id: 'x1', labels: [], parent_issue_id: 'p', metadata: {}, ...o });
const cfg = { AGENTS: { [PLANNING_AGENT]: { id: 'planner' }, build: { id: 'b' } } };

test('dispatchEligible: no guard in play is ok', () => {
  assert.deepEqual(dispatchEligible(issue(), 'build', { cfg, agent: 'build', runtime: 'rt' }), { ok: true });
});

test('dispatchEligible: spent caps stop the pass', () => {
  assert.deepEqual(dispatchEligible(issue(), 'build', { assigned: 2, maxAssign: 2 }), { ok: false, reason: 'max-assign', stop: true });
  assert.deepEqual(dispatchEligible(issue(), 'cascade', { passCount: 3, passCap: 3 }), { ok: false, reason: 'pass-cap', stop: true });
});

test('dispatchEligible: guards apply in a fixed order', () => {
  const ctx = {
    cfg, agent: 'build', runtime: 'rt', assigned: 1, maxAssign: 1,
    blockedRuntimes: new Set(['rt']), agentCycleAssigns: { build: 5 }, perCyclePerAgent: 1,
  };
  const parked = issue({ metadata: { blocked_reason: 'waiting' }, labels: ['idea'] });
  assert.equal(dispatchEligible(parked, 'build', ctx).reason, 'max-assign');
  assert.equal(dispatchEligible(parked, 'build', { ...ctx, maxAssign: 9 }).reason, 'agent-parked');
  assert.equal(dispatchEligible(issue({ labels: ['idea'] }), 'build', { ...ctx, maxAssign: 9 }).reason, 'seed');
  assert.equal(dispatchEligible(issue(), 'build', { ...ctx, maxAssign: 9 }).reason, 'runtime-blocked');
  assert.equal(dispatchEligible(issue(), 'build', { ...ctx, maxAssign: 9, blockedRuntimes: new Set() }).reason, 'per-cycle-per-agent-cap');
});

test('dispatchEligible: rerun-on-assignee passes keep their assignee-runtime-blocked reason', () => {
  const ctx = { agent: 'build', runtime: 'rt', blockedRuntimes: new Set(['rt']) };
  for (const pass of ['cascade-rerun', 'zombie-rerun', 'zombie-assign']) {
    assert.equal(dispatchEligible(issue(), pass, ctx).reason, 'assignee-runtime-blocked', pass);
  }
  for (const pass of ['cascade', 'review', 'review-rerun', 'assigned-idle', 'build']) {
    assert.equal(dispatchEligible(issue(), pass, ctx).reason, 'runtime-blocked', pass);
  }
});

test('dispatchEligible: a seed is only ever routed to the planning agent', () => {
  const seed = issue({ labels: ['idea'] });
  for (const pass of ['build', 'cascade', 'review', 'zombie-assign']) {
    assert.equal(dispatchEligible(seed, pass, { cfg, agent: 'build' }).reason, 'seed', pass);
    assert.deepEqual(dispatchEligible(seed, pass, { cfg, agent: PLANNING_AGENT }), { ok: true }, pass);
  }
});

test('dispatchEligible: a rerun on the current assignee is never seed-guarded (PANT-643)', () => {
  const seed = issue({ labels: ['idea'] });
  for (const pass of ['cascade-rerun', 'review-rerun', 'zombie-rerun', 'assigned-idle']) {
    assert.deepEqual(dispatchEligible(seed, pass, { cfg, agent: 'build' }), { ok: true }, pass);
  }
});

test('dispatchEligible: only the build pass uses the top-level + childless seed heuristic', () => {
  const topLevel = issue({ parent_issue_id: null });
  assert.equal(dispatchEligible(topLevel, 'build', { cfg, agent: 'build', allIssues: [topLevel] }).reason, 'seed');
  assert.deepEqual(dispatchEligible(topLevel, 'cascade', { cfg, agent: 'build', allIssues: [topLevel] }), { ok: true });
});

test('dispatchEligible: hive stories are exempt from the seed guard', () => {
  const hive = issue({ labels: ['idea', 'implementation'] });
  assert.deepEqual(dispatchEligible(hive, 'build', { cfg, agent: 'build', allIssues: [hive] }), { ok: true });
});

test('isRateLimitError', () => {
  assert.equal(isRateLimitError(new Error('multica: rate limited (429)')), true);
  assert.equal(isRateLimitError(new Error('quota exhausted')), true);
  assert.equal(isRateLimitError(new Error('ECONNRESET')), false);
  assert.equal(isRateLimitError(undefined), false);
});
