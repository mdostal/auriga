// Tests for lib/capacity.mjs (t011 decomposition) — the module's own
// direct contract test (core.test.mjs already covers these functions
// extensively via core.mjs's re-export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeInflight, computeAssignedQueued, computeRuntimeInflight, agentHasCapacity,
  computeReviewInflight, chooseReviewAgent,
} from '../lib/capacity.mjs';

const AGENTS = {
  'build-a': { id: 'A', runtime: 'claude', maxInflight: 2 },
  'build-b': { id: 'B', runtime: 'codex', maxInflight: 3 },
};

test('computeInflight: only counts actively-running assignments, not assigned-todos (the dead-zone fix)', () => {
  const issues = [
    { assignee_id: 'A', status: 'in_progress' },
    { assignee_id: 'A', status: 'todo' },
    { assignee_id: 'B', status: 'running' },
  ];
  const counts = computeInflight(issues, AGENTS);
  assert.equal(counts['build-a'], 1);
  assert.equal(counts['build-b'], 1);
});

test('computeAssignedQueued: counts assigned-but-still-todo issues (observability only)', () => {
  const issues = [{ assignee_id: 'A', status: 'todo' }, { assignee_id: 'A', status: 'in_progress' }];
  const counts = computeAssignedQueued(issues, AGENTS);
  assert.equal(counts['build-a'], 1);
});

test('computeRuntimeInflight: sums per-agent inflight into per-runtime totals', () => {
  const rt = computeRuntimeInflight({ 'build-a': 2, 'build-b': 1 }, AGENTS);
  assert.equal(rt.claude, 2);
  assert.equal(rt.codex, 1);
});

test('agentHasCapacity: false when the agent is unknown, at maxInflight, or its runtime is at cap', () => {
  assert.equal(agentHasCapacity('nonexistent', AGENTS, {}, {}, {}, { perAgent: {}, perRuntime: {} }), false);
  assert.equal(agentHasCapacity('build-a', AGENTS, {}, { 'build-a': 2 }, {}, { perAgent: {}, perRuntime: {} }), false);
  assert.equal(agentHasCapacity('build-a', AGENTS, { claude: 2 }, {}, { claude: 2 }, { perAgent: {}, perRuntime: {} }), false);
  assert.equal(agentHasCapacity('build-a', AGENTS, { claude: 5 }, {}, {}, { perAgent: {}, perRuntime: {} }), true);
});

const REVIEW_CFG = { REVIEW_LANE: ['auriga-review'], AGENTS: { 'auriga-review': { id: 'RV', maxInflight: 1 } } };

test('computeReviewInflight: counts in_review issues currently assigned to a review-lane agent', () => {
  const counts = computeReviewInflight([{ assignee_id: 'RV' }, { assignee_id: 'other' }], REVIEW_CFG);
  assert.equal(counts['auriga-review'], 1);
});

test('chooseReviewAgent: null when the whole lane is at capacity', () => {
  assert.equal(chooseReviewAgent(REVIEW_CFG, { 'auriga-review': 1 }), null);
  assert.equal(chooseReviewAgent(REVIEW_CFG, { 'auriga-review': 0 }), 'auriga-review');
});

test('chooseReviewAgent: returns null when the review agent runtime is in blockedRuntimes (PANT-587)', () => {
  // Without fix: blockedRuntimes parameter missing → rate-limited review runtime still selected.
  // With fix: chooseReviewAgent returns null, preventing dispatch to a blocked runtime.
  const cfgWithRt = {
    REVIEW_LANE: ['auriga-review'],
    AGENTS: { 'auriga-review': { id: 'RV', maxInflight: 1, runtime: 'claude-review' } },
  };
  const blocked = new Set(['claude-review']);
  assert.equal(chooseReviewAgent(cfgWithRt, {}, {}, blocked), null,
    'must return null when the only review agent runtime is blocked');
  assert.equal(chooseReviewAgent(cfgWithRt, {}, {}, new Set()),
    'auriga-review', 'must still select agent when runtime is not blocked');
});

test('chooseReviewAgent: missing maxInflight field treats cap as Infinity — agent is still eligible regardless of inflight count', () => {
  // Before the fix: `now < undefined` is false → agent filtered out → review dispatch
  // never fires even though agentHasCapacity correctly allows the same agent.
  const cfgNoCap = { REVIEW_LANE: ['rv-no-cap'], AGENTS: { 'rv-no-cap': { id: 'X' } } };
  assert.equal(
    chooseReviewAgent(cfgNoCap, { 'rv-no-cap': 999 }),
    'rv-no-cap',
    'review agent without maxInflight must never be blocked by the per-agent cap filter',
  );
});

test('agentHasCapacity: missing maxInflight field treats cap as Infinity — agent always has capacity regardless of inflight count', () => {
  const agents = { 'agent-no-cap': { id: 'X', runtime: 'claude' } };
  // Without the fix: `agentNow >= undefined` is NaN comparison → always false → agent had unlimited
  // capacity but silently (no explicit contract). With the fix: `?? Infinity` makes the contract explicit.
  // Either way the agent has capacity; what we verify is that the fix does NOT accidentally block
  // an agent that has no maxInflight configured.
  assert.equal(
    agentHasCapacity('agent-no-cap', agents, {}, { 'agent-no-cap': 999 }, {}, { perAgent: {}, perRuntime: {} }),
    true,
    'agent without maxInflight must never be blocked by the per-agent cap check alone',
  );
});
