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
