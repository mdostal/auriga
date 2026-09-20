// p2-router-cutover's acceptance test: drives the REAL, cut-over
// auriga-router.mjs cycle() end-to-end using ONLY this epic's stub adapters
// (lib/adapters/stub/backlog.mjs + stub/spawn.mjs) against the shared
// test-profiles-runners.mjs fixture set, with ZERO external process calls
// attempted. Per explicit project policy, no live or mocked-CLI Multica
// board is used anywhere in this story's verification — see this story's
// design_decisions.
//
// Module-namespace mechanics: see standalone-smoke.test.mjs's header comment
// for why node:test's `t.mock.module` (not a plain namespace-object patch)
// is required to intercept node:child_process for a module (lib/multica.mjs
// used to be the only importer; now the live-default adapters under
// lib/adapters/multica/*.mjs are) — hence `cycle` is imported dynamically,
// inside the test, after the mock is registered. auriga-router.mjs's
// module-level default-adapter construction (createMulticaBacklogAdapter()/
// createMulticaSpawnAdapter()) is cheap (a factory closure; no CLI call
// happens until a method is invoked) and is never exercised here anyway,
// since every test below passes explicit stub backlog/spawn instances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStubBacklogAdapter } from '../lib/adapters/stub/backlog.mjs';
import { createStubSpawnAdapter } from '../lib/adapters/stub/spawn.mjs';
import {
  ALL_PROFILES,
  PROFILE_TODO,
  PROFILE_IN_PROGRESS_DONE_RUN,
  PROFILE_IN_REVIEW_MERGED_PR,
  PROFILE_BLOCKED_CLEARED,
  RUNS_BY_IDENTIFIER,
  PULL_REQUESTS_BY_IDENTIFIER,
} from './fixtures/test-profiles-runners.mjs';

const NOOP_SLEEP = async () => {};
const NOOP_LOG = () => {};

function createLogSink() {
  const events = [];
  const log = (event, data) => { events.push({ event, ...data }); };
  log.events = events;
  log.byEvent = (event) => events.filter((e) => e.event === event);
  return log;
}

// Shallow-clone every fixture issue before seeding: the stub backlog adapter
// mutates issue objects IN PLACE (by reference), and these fixtures are a
// SHARED module-level export reused by other test files (standalone-smoke,
// stub-adapters), so a test here must not permanently mutate the canonical
// fixture objects.
//
// listAllIssues: the stub adapter only implements the BacklogAdapter
// TYPEDEF contract (listIssues per-project + listAllProjectIds) — it does
// NOT carry multica/backlog.mjs's "ported extra" listAllIssues aggregate
// (see that file's own doc comment: it is a Multica-specific port, not part
// of the typedef). cycle()'s board-wide scan calls backlog.listAllIssues
// directly (matching the real adapter, which DOES have it), so this test
// composes the equivalent aggregate from the stub's two contractual methods
// — the same shim test/standalone-smoke.test.mjs already used for this exact
// gap before this story's cutover.
function seedAdapters() {
  const rawBacklog = createStubBacklogAdapter({
    issues: ALL_PROFILES.map((issue) => ({ ...issue, metadata: { ...issue.metadata } })),
    runsByIdentifier: RUNS_BY_IDENTIFIER,
    pullRequestsByIdentifier: PULL_REQUESTS_BY_IDENTIFIER,
  });
  const backlog = {
    ...rawBacklog,
    listAllIssues: (projectIds) => projectIds.flatMap((pid) => rawBacklog.listIssues(pid)),
  };
  const spawn = createStubSpawnAdapter();
  return { backlog, spawn };
}

test('cutover-e2e: cycle() runs end-to-end on stub adapters only, zero execFileSync calls attempted', async (t) => {
  const execFileSyncMock = t.mock.fn(() => {
    throw new Error('execFileSync must never be called when cycle() is driven only by stub adapters');
  });
  t.mock.module('node:child_process', { exports: { execFileSync: execFileSyncMock } });

  // Dynamic import AFTER the module mock above is registered, so any
  // transitive import of node:child_process (via lib/adapters/multica/*.mjs,
  // which the live-default construction at auriga-router.mjs's module top
  // pulls in) resolves to the mocked module.
  const { cycle } = await import('../auriga-router.mjs');
  const { backlog, spawn } = seedAdapters();

  const result = await cycle({ backlog, spawn, log: NOOP_LOG, sleep: NOOP_SLEEP });

  assert.ok(result, 'cycle() should resolve with a result object');
  assert.equal(typeof result.assigned, 'number');
  assert.equal(typeof result.todo, 'number');
  assert.equal(typeof result.picked, 'number');

  assert.equal(execFileSyncMock.mock.calls.length, 0, 'no execFileSync calls should have been attempted');
});

test('cutover-e2e: PROFILE_TODO is a live dispatch candidate (route/assign observed)', async (t) => {
  t.mock.module('node:child_process', { exports: { execFileSync: () => { throw new Error('must not be called'); } } });
  const { cycle } = await import('../auriga-router.mjs');
  const { backlog, spawn } = seedAdapters();
  const log = createLogSink();

  await cycle({ backlog, spawn, log, sleep: NOOP_SLEEP });

  const routed = log.byEvent('route').some((e) => e.identifier === PROFILE_TODO.identifier);
  assert.ok(routed, 'PROFILE_TODO should have been picked by the "route new todos" pass');
  // "route new todos" calls spawn.assignIssue() directly (inline
  // assign -> verify -> force-rerun) — NOT spawn.dispatch(), which exists as
  // a real, tested, behavior-preserving port of this sequence but is
  // deliberately not wired into this call site (dispatch()'s verify-wait is
  // a real synchronous block, unsuited to this long-lived daemon process;
  // see auriga-router.mjs's "route new todos" comment).
  const dispatched = spawn.calls.some((c) => c.method === 'assignIssue' && c.args.id === PROFILE_TODO.identifier);
  assert.ok(dispatched, 'spawn.assignIssue should have been called for PROFILE_TODO');
});

test('cutover-e2e: PROFILE_IN_PROGRESS_DONE_RUN advances in_progress -> in_review on a completed run', async (t) => {
  t.mock.module('node:child_process', { exports: { execFileSync: () => { throw new Error('must not be called'); } } });
  const { cycle } = await import('../auriga-router.mjs');
  const { backlog, spawn } = seedAdapters();
  const log = createLogSink();

  await cycle({ backlog, spawn, log, sleep: NOOP_SLEEP });

  const advanced = log.byEvent('advance').find((e) => e.identifier === PROFILE_IN_PROGRESS_DONE_RUN.identifier);
  assert.ok(advanced, 'PROFILE_IN_PROGRESS_DONE_RUN should have advanced');
  assert.equal(advanced.to, 'in_review');
  const stored = backlog.listIssues(PROFILE_IN_PROGRESS_DONE_RUN.project_id).find((i) => i.identifier === PROFILE_IN_PROGRESS_DONE_RUN.identifier);
  assert.equal(stored.status, 'in_review');
});

test('cutover-e2e: PROFILE_IN_REVIEW_MERGED_PR advances in_review -> done on a real merged PR (getIssuePullRequests wired)', async (t) => {
  t.mock.module('node:child_process', { exports: { execFileSync: () => { throw new Error('must not be called'); } } });
  const { cycle } = await import('../auriga-router.mjs');
  const { backlog, spawn } = seedAdapters();
  const log = createLogSink();

  await cycle({ backlog, spawn, log, sleep: NOOP_SLEEP });

  const advanced = log.byEvent('advance').find((e) => e.identifier === PROFILE_IN_REVIEW_MERGED_PR.identifier && e.to === 'done');
  assert.ok(advanced, 'PROFILE_IN_REVIEW_MERGED_PR should have advanced to done via its merged PR');
  const stored = backlog.listIssues(PROFILE_IN_REVIEW_MERGED_PR.project_id).find((i) => i.identifier === PROFILE_IN_REVIEW_MERGED_PR.identifier);
  assert.equal(stored.status, 'done');
});

test('cutover-e2e: PROFILE_BLOCKED_CLEARED unblocks blocked -> todo once its dependency is done, and is unassigned', async (t) => {
  t.mock.module('node:child_process', { exports: { execFileSync: () => { throw new Error('must not be called'); } } });
  const { cycle } = await import('../auriga-router.mjs');
  const { backlog, spawn } = seedAdapters();
  const log = createLogSink();

  await cycle({ backlog, spawn, log, sleep: NOOP_SLEEP });

  const unblocked = log.byEvent('advance').find((e) => e.identifier === PROFILE_BLOCKED_CLEARED.identifier && e.from === 'blocked' && e.to === 'todo');
  assert.ok(unblocked, 'PROFILE_BLOCKED_CLEARED should have unblocked to todo once PROFILE_DONE_DEPENDENCY was done');
  const unassigned = spawn.calls.some((c) => c.method === 'unassignIssue' && c.args.id === PROFILE_BLOCKED_CLEARED.identifier);
  assert.ok(unassigned, 'spawn.unassignIssue should have been called to re-enter PROFILE_BLOCKED_CLEARED as an unassigned candidate');
  // Status has moved off `blocked` in the stub board (a subsequent re-dispatch
  // within the SAME cycle, once unassigned, is real correct router behavior,
  // not something this test needs to further constrain).
  const stored = backlog.listIssues(PROFILE_BLOCKED_CLEARED.project_id).find((i) => i.identifier === PROFILE_BLOCKED_CLEARED.identifier);
  assert.notEqual(stored.status, 'blocked');
});
