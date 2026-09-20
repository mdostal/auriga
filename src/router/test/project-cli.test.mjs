// Tests for the `auriga project scan/add/remove/list` CLI command family
// (p6-project-cli). Two sections:
//
//   1. UNIT — lib/project-registry.mjs's new scan/upsert/remove functions
//      (listBoardProjects, scanUnregisteredProjects, isKnownBoardProject,
//      upsertProject, removeProject), exercised with plain in-memory data
//      literals and fake backlog-adapter doubles. ZERO real filesystem or
//      subprocess access anywhere in this section — mirrors
//      project-registry.test.mjs's own section 1's injected-dependency
//      convention.
//
//   2. CLI-LEVEL / REAL END-TO-END — the actual `auriga` binary
//      (bin/auriga.mjs), spawned as a real child process via execFileSync
//      (never imported as an ES module — that file's main() runs
//      unconditionally at import time, so importing it directly here would
//      execute the CLI against this test's own argv; spawning is also a
//      more faithful "CLI-level test for the new dispatch branches" per
//      this story's files_to_modify). Every invocation in this section
//      points AURIGA_PROJECTS_REGISTRY_PATH (the test-only override from
//      p6-registry-core) at a THROWAWAY temp file created by this test —
//      the real, committed src/router/projects.json is never opened, read,
//      or written by anything in this file. Board validation (`project
//      add`'s scan-before-register check) uses AURIGA_BACKLOG_ADAPTER=stub
//      plus a test-only AURIGA_STUB_PROJECT_IDS seed (bin/auriga.mjs's own
//      resolveProjectBacklog()) — an in-memory fixture, never the live
//      Multica CLI (standing rule: no live Multica testing here; that's
//      separate, Pantheon-owned e2e work).
//
//      Each step's effect is confirmed by a SEPARATE real fs.readFileSync of
//      the temp registry file after the CLI process exits — never by
//      trusting the subprocess's stdout or any in-memory state — per this
//      story's own acceptance criteria ("each step's effect is confirmed by
//      actually reading the file back afterward, not just trusting
//      in-memory state within one process").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  listBoardProjects,
  scanUnregisteredProjects,
  isKnownBoardProject,
  upsertProject,
  removeProject,
} from '../lib/project-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(__dirname, '..', 'bin', 'auriga.mjs');
const REAL_REGISTRY_PATH = join(__dirname, '..', 'projects.json');

// ============================================================================
// 1. UNIT — lib/project-registry.mjs's scan/upsert/remove, zero real I/O
// ============================================================================

const REGISTRY = {
  dispatch_order: ['id-a'],
  projects: [
    { id: 'id-a', name: 'Alpha', notes: 'n1', lane: ['lane-a'], registered_at: 't1' },
    { id: 'id-b', name: 'Beta', notes: 'n2', lane: [], registered_at: 't2' },
  ],
};

test('listBoardProjects(): prefers listAllProjects() (name-enriched) when the adapter has it', () => {
  const backlog = {
    listAllProjects: () => [{ id: 'x', name: 'X Project' }, { id: 'y', name: 'Y Project' }],
    listAllProjectIds: () => { throw new Error('should not be called — listAllProjects takes precedence'); },
  };
  assert.deepEqual(listBoardProjects(backlog), [{ id: 'x', name: 'X Project' }, { id: 'y', name: 'Y Project' }]);
});

test('listBoardProjects(): degrades to listAllProjectIds() + raw-id display when listAllProjects is absent (stub adapter shape)', () => {
  const backlog = { listAllProjectIds: () => ['id-1', 'id-2'] };
  assert.deepEqual(listBoardProjects(backlog), [{ id: 'id-1', name: 'id-1' }, { id: 'id-2', name: 'id-2' }]);
});

test('scanUnregisteredProjects(): only board projects NOT already in the registry, never mutates `data`', () => {
  const backlog = { listAllProjects: () => [{ id: 'id-a', name: 'Alpha' }, { id: 'id-c', name: 'Gamma' }] };
  const before = JSON.stringify(REGISTRY);
  const candidates = scanUnregisteredProjects(backlog, REGISTRY);
  assert.deepEqual(candidates, [{ id: 'id-c', name: 'Gamma' }]); // id-a already registered -> excluded
  assert.equal(JSON.stringify(REGISTRY), before, 'scanUnregisteredProjects must never mutate its `data` argument');
});

test('scanUnregisteredProjects(): empty registry -> every board project is a candidate', () => {
  const backlog = { listAllProjectIds: () => ['p1', 'p2'] };
  assert.deepEqual(scanUnregisteredProjects(backlog, { projects: [] }), [{ id: 'p1', name: 'p1' }, { id: 'p2', name: 'p2' }]);
});

test('isKnownBoardProject(): true for a real board id, false for a typo/nonexistent one', () => {
  const backlog = { listAllProjects: () => [{ id: 'real-id', name: 'Real' }] };
  assert.equal(isKnownBoardProject(backlog, 'real-id'), true);
  assert.equal(isKnownBoardProject(backlog, 'typo-id-xyz'), false);
});

test('upsertProject(): registers a brand-new id with defaults for omitted fields', () => {
  const result = upsertProject({ projects: [] }, { id: 'new-id' }, '2026-08-19T00:00:00Z');
  assert.deepEqual(result.projects, [{ id: 'new-id', name: 'new-id', notes: '', lane: [], registered_at: '2026-08-19T00:00:00Z' }]);
});

test('upsertProject(): registers a brand-new id with all fields given', () => {
  const result = upsertProject({ projects: [] }, { id: 'new-id', name: 'New', notes: 'hi', lane: ['lane-x'] }, 't0');
  assert.deepEqual(result.projects, [{ id: 'new-id', name: 'New', notes: 'hi', lane: ['lane-x'], registered_at: 't0' }]);
});

test('upsertProject(): IDEMPOTENT — re-adding an already-registered id updates only the given fields, in place, no duplicate', () => {
  const data = { projects: [{ id: 'id-a', name: 'Alpha', notes: 'old notes', lane: ['lane-a'], registered_at: 't1' }] };
  const result = upsertProject(data, { id: 'id-a', notes: 'new notes' }, 'SHOULD-NOT-BE-USED');
  assert.equal(result.projects.length, 1, 'must not create a duplicate entry');
  assert.deepEqual(result.projects[0], { id: 'id-a', name: 'Alpha', notes: 'new notes', lane: ['lane-a'], registered_at: 't1' });
});

test('upsertProject(): update with an empty --lane ([]) DOES overwrite lane (explicit empty array is not "omitted")', () => {
  const data = { projects: [{ id: 'id-a', name: 'Alpha', notes: '', lane: ['lane-a'], registered_at: 't1' }] };
  const result = upsertProject(data, { id: 'id-a', lane: [] });
  assert.deepEqual(result.projects[0].lane, []);
});

test('upsertProject(): pure — never mutates the input `data` object', () => {
  const data = { projects: [{ id: 'id-a', name: 'Alpha', notes: '', lane: [], registered_at: 't1' }] };
  const before = JSON.stringify(data);
  upsertProject(data, { id: 'id-a', notes: 'changed' });
  assert.equal(JSON.stringify(data), before);
});

test('removeProject(): fully removes an entry — identity, notes, AND lane assignment together', () => {
  const data = { dispatch_order: [], projects: [{ id: 'id-a', name: 'Alpha', notes: 'n', lane: ['lane-a'], registered_at: 't1' }] };
  const { removed, data: updated } = removeProject(data, 'id-a');
  assert.equal(removed, true);
  assert.deepEqual(updated.projects, []);
});

test('removeProject(): also strips any stray dispatch_order entry for the same id', () => {
  const data = { dispatch_order: ['id-a', 'id-b'], projects: [{ id: 'id-a', name: 'Alpha', lane: [], registered_at: 't1' }] };
  const { data: updated } = removeProject(data, 'id-a');
  assert.deepEqual(updated.dispatch_order, ['id-b']);
});

test('removeProject(): removing an id that is not registered is a safe no-op — removed:false, data unchanged', () => {
  const data = { dispatch_order: [], projects: [{ id: 'id-a', name: 'Alpha', lane: [], registered_at: 't1' }] };
  const { removed, data: updated } = removeProject(data, 'does-not-exist');
  assert.equal(removed, false);
  assert.deepEqual(updated.projects, data.projects);
});

test('removeProject(): pure — never mutates the input `data` object', () => {
  const data = { dispatch_order: [], projects: [{ id: 'id-a', name: 'Alpha', lane: [], registered_at: 't1' }] };
  const before = JSON.stringify(data);
  removeProject(data, 'id-a');
  assert.equal(JSON.stringify(data), before);
});

// ============================================================================
// 2. CLI-LEVEL — real spawned `auriga` binary, throwaway registry path
// ============================================================================

/**
 * Spawns the real bin/auriga.mjs as a child process (via `node <path>`, not
 * relying on the shebang/executable bit). Never throws on a non-zero exit —
 * collapses execFileSync's throw-on-nonzero into a uniform result, same
 * shape as agent-setup.mjs's own run() helper.
 */
function runCli(args, envOverrides = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...envOverrides },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : '',
    };
  }
}

function readRegistryFileDirect(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('CLI: `auriga project scan` degrades to raw-id display against the stub adapter without erroring', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'auriga-projects-scan-'));
  const registryPath = join(tmpDir, 'projects.json');
  writeFileSync(registryPath, JSON.stringify({ dispatch_order: [], projects: [] }, null, 2) + '\n', 'utf8');
  try {
    const result = runCli(['project', 'scan'], {
      AURIGA_PROJECTS_REGISTRY_PATH: registryPath,
      AURIGA_BACKLOG_ADAPTER: 'stub',
      AURIGA_STUB_PROJECT_IDS: 'raw-id-1,raw-id-2',
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /raw-id-1/);
    assert.match(result.stdout, /raw-id-2/);
    // READ-ONLY: the registry file on disk must be byte-identical to what we seeded.
    assert.deepEqual(readRegistryFileDirect(registryPath), { dispatch_order: [], projects: [] });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: `auriga project add` rejects a typo/nonexistent id with a clear error and makes zero registry mutations', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'auriga-projects-badid-'));
  const registryPath = join(tmpDir, 'projects.json');
  const seed = { dispatch_order: [], projects: [] };
  writeFileSync(registryPath, JSON.stringify(seed, null, 2) + '\n', 'utf8');
  try {
    const result = runCli(['project', 'add', 'totally-fake-id-not-on-the-board'], {
      AURIGA_PROJECTS_REGISTRY_PATH: registryPath,
      AURIGA_BACKLOG_ADAPTER: 'stub',
      AURIGA_STUB_PROJECT_IDS: 'some-other-real-id',
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not a known project/i);
    assert.deepEqual(readRegistryFileDirect(registryPath), seed, 'a rejected add must not touch the registry file at all');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('REAL END-TO-END: add (new) -> list -> add again (idempotent update) -> remove -> list, each step confirmed by reading the throwaway file back off disk', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'auriga-projects-e2e-'));
  const registryPath = join(tmpDir, 'projects.json');
  const TEST_ID = 'e2e-test-project-id-0001';
  writeFileSync(registryPath, JSON.stringify({ dispatch_order: [], projects: [] }, null, 2) + '\n', 'utf8');

  const baseEnv = { AURIGA_PROJECTS_REGISTRY_PATH: registryPath, AURIGA_BACKLOG_ADAPTER: 'stub' };

  try {
    // Precondition: this is a throwaway path, never the real committed file.
    assert.notEqual(registryPath, REAL_REGISTRY_PATH);

    // ---- Step 1: add (new registration), validated against a fresh stub scan ----
    const addResult = runCli(
      ['project', 'add', TEST_ID, '--name', 'E2E Test Project', '--notes', 'initial notes', '--lane', 'lane-a,lane-b'],
      { ...baseEnv, AURIGA_STUB_PROJECT_IDS: TEST_ID },
    );
    assert.equal(addResult.code, 0, `add should succeed: ${addResult.stderr}`);
    assert.match(addResult.stdout, /registered project/);

    let onDisk = readRegistryFileDirect(registryPath);
    assert.equal(onDisk.projects.length, 1);
    assert.deepEqual(onDisk.projects[0].id, TEST_ID);
    assert.equal(onDisk.projects[0].name, 'E2E Test Project');
    assert.equal(onDisk.projects[0].notes, 'initial notes');
    assert.deepEqual(onDisk.projects[0].lane, ['lane-a', 'lane-b']);
    assert.ok(onDisk.projects[0].registered_at, 'a new registration must stamp registered_at');
    const originalRegisteredAt = onDisk.projects[0].registered_at;

    // ---- Step 2: list — read-only, reflects the on-disk state ----
    const listResult1 = runCli(['project', 'list'], baseEnv);
    assert.equal(listResult1.code, 0);
    assert.match(listResult1.stdout, new RegExp(TEST_ID));
    assert.match(listResult1.stdout, /E2E Test Project/);
    assert.match(listResult1.stdout, /initial notes/);
    assert.match(listResult1.stdout, /lane-a,lane-b/);
    // list is read-only — file on disk must be unchanged.
    assert.deepEqual(readRegistryFileDirect(registryPath), onDisk);

    // ---- Step 3: add again — IDEMPOTENT update, notes only, name/lane untouched ----
    const updateResult = runCli(
      ['project', 'add', TEST_ID, '--notes', 'updated notes'],
      baseEnv, // no AURIGA_STUB_PROJECT_IDS needed — already-registered ids skip board validation
    );
    assert.equal(updateResult.code, 0, `update-via-add should succeed: ${updateResult.stderr}`);
    assert.match(updateResult.stdout, /updated project/);

    onDisk = readRegistryFileDirect(registryPath);
    assert.equal(onDisk.projects.length, 1, 'idempotent add must not create a duplicate entry');
    assert.equal(onDisk.projects[0].notes, 'updated notes');
    assert.equal(onDisk.projects[0].name, 'E2E Test Project', 'name must be unchanged — it was not passed to the second add');
    assert.deepEqual(onDisk.projects[0].lane, ['lane-a', 'lane-b'], 'lane must be unchanged — it was not passed to the second add');
    assert.equal(onDisk.projects[0].registered_at, originalRegisteredAt, 'registered_at must be preserved across an update');

    // ---- Step 4: list again — reflects the update ----
    const listResult2 = runCli(['project', 'list'], baseEnv);
    assert.equal(listResult2.code, 0);
    assert.match(listResult2.stdout, /updated notes/);
    assert.doesNotMatch(listResult2.stdout, /initial notes/);

    // ---- Step 5: remove — deletes the entry (identity, notes, lane) entirely ----
    const removeResult = runCli(['project', 'remove', TEST_ID], baseEnv);
    assert.equal(removeResult.code, 0, `remove should succeed: ${removeResult.stderr}`);
    assert.match(removeResult.stdout, /removed project/);

    onDisk = readRegistryFileDirect(registryPath);
    assert.deepEqual(onDisk.projects, [], 'the entry — including its lane assignment — must be fully gone');

    // ---- Step 6: list again — the removed project no longer appears ----
    const listResult3 = runCli(['project', 'list'], baseEnv);
    assert.equal(listResult3.code, 0);
    assert.doesNotMatch(listResult3.stdout, new RegExp(TEST_ID));
    assert.match(listResult3.stdout, /empty/);

    // Sanity: the real, committed registry was never touched by any of this.
    assert.ok(existsSync(REAL_REGISTRY_PATH));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: `auriga project remove` on a never-registered id fails clearly instead of silently succeeding', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'auriga-projects-remove-missing-'));
  const registryPath = join(tmpDir, 'projects.json');
  const seed = { dispatch_order: [], projects: [] };
  writeFileSync(registryPath, JSON.stringify(seed, null, 2) + '\n', 'utf8');
  try {
    const result = runCli(['project', 'remove', 'never-registered-id'], { AURIGA_PROJECTS_REGISTRY_PATH: registryPath });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not registered/i);
    assert.deepEqual(readRegistryFileDirect(registryPath), seed);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
