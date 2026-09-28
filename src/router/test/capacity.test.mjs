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

// PANT-846 (GH #240): live on hive three in_progress issues with no running task
// (two zombies, one parent waiting on staged sub-issues) filled claude-planning's
// RUNTIME_CAP=3 and the planning lane dispatched nothing for hours.
test('computeInflight: with runs known, counts an in_progress issue only while it has an active, fresh run (PANT-846)', () => {
  const now = Date.parse('2026-09-28T03:30:00Z');
  const hoursAgo = (h) => new Date(now - h * 3600e3).toISOString();
  const issues = [
    { identifier: 'LIVE', assignee_id: 'A', status: 'in_progress' },
    { identifier: 'CANCELLED', assignee_id: 'A', status: 'in_progress' },
    { identifier: 'NO-RUNS', assignee_id: 'A', status: 'in_progress' },
    { identifier: 'HUNG', assignee_id: 'B', status: 'running' },
  ];
  const runsByIssue = {
    LIVE: [{ status: 'running', started_at: hoursAgo(0.1) }],
    CANCELLED: [{ status: 'cancelled', created_at: hoursAgo(24), completed_at: hoursAgo(24) }],
    'NO-RUNS': [],
    HUNG: [{ status: 'running', started_at: hoursAgo(5) }],
  };
  const counts = computeInflight(issues, AGENTS, { runsByIssue, now, staleMs: 3600e3 });
  assert.equal(counts['build-a'], 1, 'only the live run holds a slot');
  assert.equal(counts['build-b'], 0, 'a run past the zombie stale window is a hang, not work');
});

test('computeInflight: a parent waiting on non-terminal children holds no slot (PANT-846)', () => {
  const issues = [
    { id: 'P', identifier: 'PARENT', assignee_id: 'A', status: 'in_progress' },
    { id: 'C1', parent_issue_id: 'P', status: 'done' },
    { id: 'C2', parent_issue_id: 'P', status: 'todo', assignee_id: 'human' },
    { id: 'Q', identifier: 'DONE-KIDS', assignee_id: 'A', status: 'in_progress' },
    { id: 'C3', parent_issue_id: 'Q', status: 'cancelled' },
  ];
  // No runs known: status fallback, minus the waiting parent.
  assert.equal(computeInflight(issues, AGENTS)['build-a'], 1);
  // Runs known: a parent that does have its own live run still counts.
  const runsByIssue = { PARENT: [{ status: 'running', started_at: new Date().toISOString() }] };
  assert.equal(computeInflight(issues, AGENTS, { runsByIssue })['build-a'], 2);
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

// ---- PANT-737: seed-labeled tickets must not hold inflight slots -----------

test('computeReviewInflight: seed-labeled (idea) issue assigned to review agent does not count — PANT-737', () => {
  const seed = { assignee_id: 'RV', labels: [{ name: 'idea' }] };
  const normal = { assignee_id: 'RV', labels: [] };
  const counts = computeReviewInflight([seed, normal], REVIEW_CFG);
  assert.equal(counts['auriga-review'], 1, 'only the non-seed issue counts');
});

test('computeReviewInflight: not-a-seed label overrides idea — issue counts normally', () => {
  const notSeed = { assignee_id: 'RV', labels: [{ name: 'idea' }, { name: 'not-a-seed' }] };
  const counts = computeReviewInflight([notSeed], REVIEW_CFG);
  assert.equal(counts['auriga-review'], 1);
});

test('computeReviewInflight: needs-plan label also excludes from inflight — PANT-737', () => {
  const seed = { assignee_id: 'RV', labels: [{ name: 'needs-plan' }] };
  const counts = computeReviewInflight([seed], REVIEW_CFG);
  assert.equal(counts['auriga-review'], 0);
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
