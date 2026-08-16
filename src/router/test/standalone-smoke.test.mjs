// Standalone smoke test: the REAL auriga-router.mjs cycle() (unmodified —
// this story never touches that file) runs end-to-end using ONLY this
// story's stub adapters, with ZERO external process calls. lib/multica.mjs
// is the only module in this codebase that calls node:child_process's
// execFileSync (see that file), so mocking it and asserting zero calls is a
// direct proof that cycle() never fell through to a live `multica`/`gh` CLI.
//
// Module-namespace mechanics: a plain in-process monkey-patch of
// node:child_process (e.g. `import * as cp from 'node:child_process'` then
// reassigning `cp.execFileSync`) does NOT work for a Node builtin — its ESM
// named exports are independent per-importer bindings, not a shared mutable
// object, so a patch made here would never be observed by lib/multica.mjs's
// own `import { execFileSync } from 'node:child_process'`. node:test's
// module-mocking API (`t.mock.module`, `--experimental-test-module-mocks`)
// intercepts at the loader level instead, so it works transitively for any
// module imported AFTER the mock is registered — hence `cycle` is imported
// dynamically, inside the test, after the mock is set up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStubBacklogAdapter } from '../lib/adapters/stub/backlog.mjs';
import { createStubSpawnAdapter } from '../lib/adapters/stub/spawn.mjs';
import {
  ALL_PROFILES,
  RUNS_BY_IDENTIFIER,
  PULL_REQUESTS_BY_IDENTIFIER,
} from './fixtures/test-profiles-runners.mjs';

const NOOP_SLEEP = async () => {};
const NOOP_LOG = () => {};

// Wires the stub adapters straight in as cycle()'s `opts.mca` — both are
// synchronous now (see ../lib/adapters/*.mjs), matching exactly the call
// convention cycle() already uses for its real mcaImpl.* call sites (see
// auriga-router.mjs's own doc comment on cycle(): it never `await`s them).
// No Promise-resolution/caching bridge is needed anymore — every call below
// forwards straight into the stub adapter and returns its plain result.
//
// cycle()'s mcaImpl.* call sites use vendor-shaped method names
// (listAllIssues/issueRuns/issueStatus/...) while BacklogAdapter/SpawnAdapter
// intentionally use vendor-agnostic names (see lib/adapters/README.md) — that
// naming difference is a pre-existing, permanent property of the two-adapter
// abstraction (not something this fix changes), so a one-line-per-method
// name mapping remains here. What this fix removes is the async/Promise
// bridging that mismatch used to require.
function mcaFromAdapters(backlog, spawn) {
  return {
    listAllProjectIds: () => backlog.listAllProjectIds(),
    listAllIssues: (projectIds) => projectIds.flatMap((pid) => backlog.listIssues(pid)),
    issueRuns: (identifier) => backlog.getIssueRuns(identifier),
    issuePullRequests: (identifier) => backlog.getIssuePullRequests(identifier),
    issueStatus: (identifier, status) => backlog.setIssueStatus(identifier, status),
    issueComment: (identifier, body) => backlog.commentOnIssue(identifier, body),
    assignIssue: (identifier, agentName) => spawn.assignIssue(identifier, agentName),
    rerunIssue: (identifier) => spawn.rerunIssue(identifier),
    unassignIssue: (identifier) => spawn.unassignIssue(identifier),
    // GitHub-flavored PR/repo discovery is deliberately OUTSIDE the
    // two-adapter model (see lib/adapters/README.md's no-pre-emptive-
    // integrations rule) — cycle() still calls these unconditionally today,
    // so this smoke test stubs them to empty, proving they never reach a
    // real `gh` process either.
    ghPrs: () => [],
    ghListRepos: () => [],
    ghOpenPrs: () => [],
  };
}

test('standalone smoke: cycle() runs end-to-end on stub adapters only, zero execFileSync calls attempted', async (t) => {
  const execFileSyncMock = t.mock.fn(() => {
    throw new Error('execFileSync must never be called when cycle() is driven only by stub adapters');
  });
  t.mock.module('node:child_process', { exports: { execFileSync: execFileSyncMock } });

  // Dynamic import AFTER the module mock above is registered, so
  // auriga-router.mjs's own transitive import of node:child_process (via
  // lib/multica.mjs) resolves to the mocked module. auriga-router.mjs itself
  // is otherwise completely unmodified.
  const { cycle } = await import('../auriga-router.mjs');

  // Shallow-clone every fixture issue before seeding: the stub backlog
  // adapter mutates issue objects IN PLACE (by reference — the same
  // behavior test/support/mock-mca.mjs relies on), and these fixtures are a
  // SHARED module-level export reused by other test files, so this test must
  // not permanently mutate the canonical fixture objects.
  const backlog = createStubBacklogAdapter({
    issues: ALL_PROFILES.map((issue) => ({ ...issue })),
    runsByIdentifier: RUNS_BY_IDENTIFIER,
    pullRequestsByIdentifier: PULL_REQUESTS_BY_IDENTIFIER,
  });
  const spawn = createStubSpawnAdapter();
  const mca = mcaFromAdapters(backlog, spawn);

  const result = await cycle({ mca, log: NOOP_LOG, sleep: NOOP_SLEEP });

  assert.ok(result, 'cycle() should resolve with a result object');
  assert.equal(typeof result.assigned, 'number');
  assert.equal(typeof result.todo, 'number');
  assert.equal(typeof result.picked, 'number');

  assert.equal(execFileSyncMock.mock.calls.length, 0, 'no execFileSync calls should have been attempted');
  assert.ok(spawn.calls.length > 0, 'the stub spawn adapter should have recorded at least one action');
});
