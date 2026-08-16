// Standalone smoke test: the REAL auriga-router.mjs cycle() runs end-to-end
// using ONLY this story's stub adapters, with ZERO external process calls.
// lib/adapters/multica/*.mjs are the only modules in this codebase that call
// node:child_process's execFileSync (see those files — lib/multica.mjs is
// their pre-cutover predecessor), so mocking it and asserting zero calls is
// a direct proof that cycle() never fell through to a live `multica`/`gh`
// CLI.
//
// p2-router-cutover update: cycle() now takes opts.backlog/opts.spawn
// directly (typed adapter instances) instead of opts.mca, so the
// mcaFromAdapters() vendor-shaped bridge this test used pre-cutover is gone
// — the stub adapters are wired straight in.
//
// Module-namespace mechanics: a plain in-process monkey-patch of
// node:child_process (e.g. `import * as cp from 'node:child_process'` then
// reassigning `cp.execFileSync`) does NOT work for a Node builtin — its ESM
// named exports are independent per-importer bindings, not a shared mutable
// object, so a patch made here would never be observed by the adapters' own
// `import { execFileSync } from 'node:child_process'`. node:test's
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

test('standalone smoke: cycle() runs end-to-end on stub adapters only, zero execFileSync calls attempted', async (t) => {
  const execFileSyncMock = t.mock.fn(() => {
    throw new Error('execFileSync must never be called when cycle() is driven only by stub adapters');
  });
  t.mock.module('node:child_process', { exports: { execFileSync: execFileSyncMock } });

  // Dynamic import AFTER the module mock above is registered, so
  // auriga-router.mjs's own transitive import of node:child_process (via
  // lib/adapters/multica/*.mjs's live-default construction) resolves to the
  // mocked module. auriga-router.mjs itself is otherwise unmodified by this
  // test file.
  const { cycle } = await import('../auriga-router.mjs');

  // Shallow-clone every fixture issue before seeding: the stub backlog
  // adapter mutates issue objects IN PLACE (by reference — the same
  // behavior test/support/mock-mca.mjs relies on), and these fixtures are a
  // SHARED module-level export reused by other test files, so this test must
  // not permanently mutate the canonical fixture objects.
  const rawBacklog = createStubBacklogAdapter({
    issues: ALL_PROFILES.map((issue) => ({ ...issue })),
    runsByIdentifier: RUNS_BY_IDENTIFIER,
    pullRequestsByIdentifier: PULL_REQUESTS_BY_IDENTIFIER,
  });
  // listAllIssues: the stub only implements the BacklogAdapter typedef
  // contract (listIssues + listAllProjectIds); cycle()'s board-wide scan
  // calls the "ported extra" listAllIssues the real multica adapter carries
  // (see multica/backlog.mjs) — composed here from the two contractual
  // methods, same gap this file's old mcaFromAdapters bridge papered over.
  const backlog = {
    ...rawBacklog,
    listAllIssues: (projectIds) => projectIds.flatMap((pid) => rawBacklog.listIssues(pid)),
  };
  const spawn = createStubSpawnAdapter();

  const result = await cycle({ backlog, spawn, log: NOOP_LOG, sleep: NOOP_SLEEP });

  assert.ok(result, 'cycle() should resolve with a result object');
  assert.equal(typeof result.assigned, 'number');
  assert.equal(typeof result.todo, 'number');
  assert.equal(typeof result.picked, 'number');

  assert.equal(execFileSyncMock.mock.calls.length, 0, 'no execFileSync calls should have been attempted');
  assert.ok(spawn.calls.length > 0, 'the stub spawn adapter should have recorded at least one action');
});
