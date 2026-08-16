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

// Bridges the async BacklogAdapter/SpawnAdapter contract onto the
// SYNCHRONOUS shape auriga-router.mjs's cycle() actually calls — cycle()
// never `await`s its injected `mca` dependency (see its own doc comment).
// The stub adapters have no internal `await`, so every call's side effect
// (a store mutation, a `.calls` push) already happened synchronously by the
// time the call returns, even though the return VALUE is wrapped in a
// Promise. This shim exploits exactly that: it resolves the handful of
// per-issue reads once up front (the fixture set is small and fully known),
// then exposes cycle()'s expected synchronous read functions over that
// snapshot, while every write cycle() performs is forwarded straight into
// the real stub adapters (still exercised, still recorded on spawn.calls /
// backlog's own store) — a thin bridge, not a second reimplementation of
// either adapter.
async function buildMcaShim(backlog, spawn) {
  const projectIds = await backlog.listAllProjectIds();
  const issues = [];
  for (const pid of projectIds) issues.push(...(await backlog.listIssues(pid)));

  const runsCache = {};
  const prsCache = {};
  for (const issue of issues) {
    runsCache[issue.identifier] = await backlog.getIssueRuns(issue.identifier);
    prsCache[issue.identifier] = await backlog.getIssuePullRequests(issue.identifier);
  }

  return {
    listAllProjectIds: () => projectIds,
    listAllIssues: (ids) => issues.filter((i) => ids.includes(i.project_id)),
    issueRuns: (identifier) => runsCache[identifier] || [],
    issuePullRequests: (identifier) => prsCache[identifier] || [],
    issueStatus: (identifier, status) => { backlog.setIssueStatus(identifier, status); return { ok: true }; },
    issueComment: (identifier, body) => { backlog.commentOnIssue(identifier, body); return { ok: true }; },
    assignIssue: (identifier, agentName) => { spawn.assignIssue(identifier, agentName); return { ok: true }; },
    rerunIssue: (identifier) => { spawn.rerunIssue(identifier); return { ok: true }; },
    unassignIssue: (identifier) => { spawn.unassignIssue(identifier); return { ok: true }; },
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
  const mca = await buildMcaShim(backlog, spawn);

  const result = await cycle({ mca, log: NOOP_LOG, sleep: NOOP_SLEEP });

  assert.ok(result, 'cycle() should resolve with a result object');
  assert.equal(typeof result.assigned, 'number');
  assert.equal(typeof result.todo, 'number');
  assert.equal(typeof result.picked, 'number');

  assert.equal(execFileSyncMock.mock.calls.length, 0, 'no execFileSync calls should have been attempted');
  assert.ok(spawn.calls.length > 0, 'the stub spawn adapter should have recorded at least one action');
});
