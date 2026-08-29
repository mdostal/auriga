import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';

const cfg = {
  PROJECT_IDS: ['PROJ'],
  HUMAN_NAMES: ['mathew', 'dostal'],
  CAPS: { perCycleTotal: 10, perCyclePerAgent: 4 },
  AGENTS: {
    'build-a': { id: 'agent-a', runtime: 'claude', maxInflight: 2 },
  },
  HIVE_LANE: ['build-a'],
  PROJECT_LANE: {},
  PROJECT_NAMES: {},
  DEFAULT_LANE: ['build-a'],
  TREE_AGENT_ATTACHMENTS: {},
  RUNTIME_CAP: { claude: 2 },
};

function changebackIssue(overrides = {}) {
  return {
    id: 'X', identifier: 'PAN-1', project_id: 'PROJ', status: 'todo',
    title: 'fix the widget', metadata: { review_verdict: 'changes' },
    ...overrides,
  };
}

// ---- detectReviewChangeback -------------------------------------------------

test('changeback: todo + review_verdict=changes in aligned project -> changeback-to-build', () => {
  const i = changebackIssue();
  const acts = core.detectReviewChangeback([i], cfg);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].identifier, 'PAN-1');
  assert.equal(acts[0].action, 'changeback-to-build');
  assert.equal(acts[0].issueId, 'X');
  assert.equal(acts[0].projectId, 'PROJ');
});

test('changeback: multiple qualifying stories all detected in one pass', () => {
  const a = changebackIssue({ id: 'A', identifier: 'PAN-1' });
  const b = changebackIssue({ id: 'B', identifier: 'PAN-2' });
  const acts = core.detectReviewChangeback([a, b], cfg);
  assert.equal(acts.length, 2);
  assert.deepEqual(acts.map((a) => a.identifier).sort(), ['PAN-1', 'PAN-2']);
});

test('changeback: in_progress story with changes verdict is NOT detected (wrong status)', () => {
  const i = changebackIssue({ status: 'in_progress' });
  assert.equal(core.detectReviewChangeback([i], cfg).length, 0);
});

test('changeback: todo with review_verdict=pass is NOT detected (not a loop-back)', () => {
  const i = changebackIssue({ metadata: { review_verdict: 'pass' } });
  assert.equal(core.detectReviewChangeback([i], cfg).length, 0);
});

test('changeback: todo with no metadata is NOT detected', () => {
  const i = changebackIssue({ metadata: undefined });
  assert.equal(core.detectReviewChangeback([i], cfg).length, 0);
});

test('changeback: story in unaligned project is excluded', () => {
  const i = changebackIssue({ project_id: 'OTHER' });
  assert.equal(core.detectReviewChangeback([i], cfg).length, 0);
});

test('changeback: human-todo story is excluded even when review_verdict=changes is set', () => {
  const i = changebackIssue({ labels: [{ name: 'human-todo' }] });
  assert.equal(core.detectReviewChangeback([i], cfg).length, 0);
});

test('changeback: smoke/scratch story is excluded', () => {
  const i = changebackIssue({ title: '[smoke] basic sanity' });
  assert.equal(core.detectReviewChangeback([i], cfg).length, 0);
});

// ---- exclusion integration: changedBack stories are not double-dispatched ----

test('changeback exclusion: identifiers in changedBack set are skipped by selectAssignments', () => {
  // Two todo stories, both eligible for dispatch. Give both a parent so isSeed() returns false
  // (top-level childless issues route to minerva-dev, which is not in this minimal cfg).
  const changed = changebackIssue({ id: 'A', identifier: 'PAN-1', parent_issue_id: 'EPIC', metadata: { review_verdict: 'changes' } });
  const fresh = { id: 'B', identifier: 'PAN-2', project_id: 'PROJ', status: 'todo', title: 'new work', parent_issue_id: 'EPIC' };
  const issues = [changed, fresh];

  // Router collects changeback identifiers.
  const changebacks = core.detectReviewChangeback(issues, cfg);
  const changedBack = new Set(changebacks.map((c) => c.identifier)); // {'PAN-1'}

  // selectAssignments is called with those identifiers in the exclude set.
  const picks = core.selectAssignments(issues, cfg, {}, { exclude: changedBack });
  const pickedIds = picks.map((p) => p.identifier);

  assert.ok(!pickedIds.includes('PAN-1'), 'changeback story must not be re-dispatched by selectAssignments');
  assert.ok(pickedIds.includes('PAN-2'), 'fresh todo story must still be dispatched');
});

test('changeback exclusion: empty changedBack set leaves all eligible stories available', () => {
  const a = { id: 'A', identifier: 'PAN-1', project_id: 'PROJ', status: 'todo', title: 'work a', parent_issue_id: 'EPIC' };
  const b = { id: 'B', identifier: 'PAN-2', project_id: 'PROJ', status: 'todo', title: 'work b', parent_issue_id: 'EPIC' };
  const picks = core.selectAssignments([a, b], cfg, {}, { exclude: new Set() });
  assert.equal(picks.length, 2);
});
