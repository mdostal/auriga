// Asserts the stub adapters satisfy the BacklogAdapter/SpawnAdapter shape
// contracts (see ../lib/adapters/*.mjs): every method is callable and
// returns the documented empty-default shape without throwing when called
// with no seed data, AND behaves correctly against a seeded fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStubBacklogAdapter } from '../lib/adapters/stub/backlog.mjs';
import { createStubSpawnAdapter } from '../lib/adapters/stub/spawn.mjs';
import {
  ALL_PROFILES,
  PROFILE_TODO,
  PROFILE_IN_PROGRESS_DONE_RUN,
  PROFILE_IN_REVIEW_MERGED_PR,
  PROFILE_DONE_DEPENDENCY,
  PROFILE_BLOCKED_CLEARED,
  RUNS_BY_IDENTIFIER,
  PULL_REQUESTS_BY_IDENTIFIER,
} from './fixtures/test-profiles-runners.mjs';

// ---- BacklogAdapter: empty-default shape, called with no arguments ----

test('createStubBacklogAdapter() with no args: every method is callable and returns the empty-default shape', async () => {
  const backlog = createStubBacklogAdapter();

  assert.deepEqual(await backlog.listIssues('any-project'), []);
  assert.deepEqual(await backlog.listAllProjectIds(), []);
  assert.deepEqual(await backlog.getIssueRuns('ANY-1'), []);
  assert.deepEqual(await backlog.getIssuePullRequests('ANY-1'), []);

  // Mutating methods must not throw even against an empty store.
  await assert.doesNotReject(backlog.setIssueStatus('ANY-1', 'todo'));
  await assert.doesNotReject(backlog.commentOnIssue('ANY-1', 'hello'));
});

// ---- SpawnAdapter: empty-default shape, called with no arguments ----

test('createStubSpawnAdapter() with no args: every method is callable, records calls, without throwing', async () => {
  const spawn = createStubSpawnAdapter();

  assert.deepEqual(spawn.calls, []);

  const lanes = await spawn.describeLanes();
  assert.ok(lanes && typeof lanes === 'object');
  assert.ok(Object.keys(lanes).length > 0, 'describeLanes() should return a non-empty fixture lane map');

  await assert.doesNotReject(spawn.dispatch({ identifier: 'ANY-1' }, 'stub-build-lane'));
  await assert.doesNotReject(spawn.assignIssue('ANY-1', 'some-agent'));
  await assert.doesNotReject(spawn.rerunIssue('ANY-1'));
  await assert.doesNotReject(spawn.unassignIssue('ANY-1'));

  assert.equal(spawn.calls.length, 4);
  assert.deepEqual(spawn.calls.map((c) => c.method), ['dispatch', 'assignIssue', 'rerunIssue', 'unassignIssue']);
});

// ---- BacklogAdapter: seeded behavior, reusing the shared fixture set ----

test('createStubBacklogAdapter(seedData): seeded issues/runs/PRs are readable and status/comments mutate in place', async () => {
  // Shallow-clone every fixture issue before seeding: the adapter mutates
  // issue objects IN PLACE (by reference), and ALL_PROFILES is a SHARED
  // module-level export other tests in this file (and other files) also
  // read — mutating status here must not leak into them.
  const backlog = createStubBacklogAdapter({
    issues: ALL_PROFILES.map((issue) => ({ ...issue })),
    runsByIdentifier: RUNS_BY_IDENTIFIER,
    pullRequestsByIdentifier: PULL_REQUESTS_BY_IDENTIFIER,
  });

  const projectIds = await backlog.listAllProjectIds();
  assert.equal(projectIds.length, 1, 'all fixture profiles share one project id');

  const issues = await backlog.listIssues(projectIds[0]);
  assert.equal(issues.length, ALL_PROFILES.length);

  const runs = await backlog.getIssueRuns(PROFILE_IN_PROGRESS_DONE_RUN.identifier);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'done');

  const prs = await backlog.getIssuePullRequests(PROFILE_IN_REVIEW_MERGED_PR.identifier);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].state, 'merged');

  await backlog.setIssueStatus(PROFILE_TODO.identifier, 'in_progress');
  const [mutated] = (await backlog.listIssues(projectIds[0])).filter((i) => i.identifier === PROFILE_TODO.identifier);
  assert.equal(mutated.status, 'in_progress');

  await backlog.commentOnIssue(PROFILE_TODO.identifier, 'hi there');
  assert.deepEqual(backlog.comments, [{ id: PROFILE_TODO.identifier, body: 'hi there' }]);
});

// ---- fixture coverage: at least one issue in each required state ----

test('test-profiles-runners.mjs fixture covers todo / in_progress-done-run / in_review-merged-PR / blocked-cleared-dependency', () => {
  assert.equal(PROFILE_TODO.status, 'todo');
  assert.equal(PROFILE_TODO.assignee_id, null);

  assert.equal(PROFILE_IN_PROGRESS_DONE_RUN.status, 'in_progress');
  const runs = RUNS_BY_IDENTIFIER[PROFILE_IN_PROGRESS_DONE_RUN.identifier];
  assert.ok(runs && runs.length > 0);
  assert.equal(runs[0].status, 'done');

  assert.equal(PROFILE_IN_REVIEW_MERGED_PR.status, 'in_review');
  const prs = PULL_REQUESTS_BY_IDENTIFIER[PROFILE_IN_REVIEW_MERGED_PR.identifier];
  assert.ok(prs && prs.length > 0);
  assert.equal(prs[0].state, 'merged');

  assert.equal(PROFILE_BLOCKED_CLEARED.status, 'blocked');
  assert.equal(PROFILE_BLOCKED_CLEARED.metadata.depends_on, PROFILE_DONE_DEPENDENCY.id);
  assert.equal(PROFILE_DONE_DEPENDENCY.status, 'done');
});
