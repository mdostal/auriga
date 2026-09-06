// CLI-level tests for `auriga orchestrator set-parent/clear-parent/add-child/
// remove-child/list` (t010) — the actual `auriga` binary spawned as a real
// child process, exactly mirroring project-cli.test.mjs's own spawning
// pattern (bin/auriga.mjs's main() runs unconditionally at import time, so
// it is never imported directly here). Every invocation points
// AURIGA_ORCHESTRATOR_TOPOLOGY_PATH at a throwaway temp file — the real,
// committed src/router/orchestrator-topology.json is never opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(__dirname, '..', 'bin', 'auriga.mjs');
const REAL_TOPOLOGY_PATH = join(__dirname, '..', 'orchestrator-topology.json');

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

function readTopologyFileDirect(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('CLI: `auriga orchestrator list` on a freshly-initialized (empty) topology reports a root node with no children', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'auriga-topology-empty-'));
  const topologyPath = join(tmpDir, 'orchestrator-topology.json');
  writeFileSync(topologyPath, JSON.stringify({ parent: null, children: [] }, null, 2) + '\n', 'utf8');
  try {
    const result = runCli(['orchestrator', 'list'], { AURIGA_ORCHESTRATOR_TOPOLOGY_PATH: topologyPath });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /parent: \(none/);
    assert.match(result.stdout, /children: \(none\)/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('REAL END-TO-END: set-parent -> add-child (x2) -> list -> remove-child -> clear-parent -> list, each step confirmed by reading the throwaway file back off disk', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'auriga-topology-e2e-'));
  const topologyPath = join(tmpDir, 'orchestrator-topology.json');
  writeFileSync(topologyPath, JSON.stringify({ parent: null, children: [] }, null, 2) + '\n', 'utf8');
  const env = { AURIGA_ORCHESTRATOR_TOPOLOGY_PATH: topologyPath };

  try {
    // Precondition: this is a throwaway path, never the real committed file.
    assert.notEqual(topologyPath, REAL_TOPOLOGY_PATH);

    // ---- Step 1: set-parent ----
    const setParentResult = runCli(['orchestrator', 'set-parent', 'meta-orchestrator', '--notes', 'top of the tree'], env);
    assert.equal(setParentResult.code, 0, setParentResult.stderr);
    assert.match(setParentResult.stdout, /parent set to meta-orchestrator/);

    let onDisk = readTopologyFileDirect(topologyPath);
    assert.deepEqual(onDisk.parent, { id: 'meta-orchestrator', notes: 'top of the tree' });
    assert.deepEqual(onDisk.children, []);

    // ---- Step 2: add-child x2 ----
    const addChild1 = runCli(['orchestrator', 'add-child', 'project-auriga', '--notes', 'per-project director'], env);
    assert.equal(addChild1.code, 0, addChild1.stderr);
    const addChild2 = runCli(['orchestrator', 'add-child', 'project-heimdall'], env);
    assert.equal(addChild2.code, 0, addChild2.stderr);

    onDisk = readTopologyFileDirect(topologyPath);
    assert.equal(onDisk.children.length, 2);
    assert.deepEqual(onDisk.children[0], { id: 'project-auriga', notes: 'per-project director' });
    assert.deepEqual(onDisk.children[1], { id: 'project-heimdall', notes: '' });

    // ---- Step 3: list — read-only, reflects on-disk state ----
    const listResult = runCli(['orchestrator', 'list'], env);
    assert.equal(listResult.code, 0);
    assert.match(listResult.stdout, /parent: meta-orchestrator \(top of the tree\)/);
    assert.match(listResult.stdout, /project-auriga \(per-project director\)/);
    assert.match(listResult.stdout, /project-heimdall/);
    assert.deepEqual(readTopologyFileDirect(topologyPath), onDisk, 'list must be read-only');

    // ---- Step 4: remove-child ----
    const removeResult = runCli(['orchestrator', 'remove-child', 'project-heimdall'], env);
    assert.equal(removeResult.code, 0, removeResult.stderr);
    onDisk = readTopologyFileDirect(topologyPath);
    assert.equal(onDisk.children.length, 1);
    assert.equal(onDisk.children[0].id, 'project-auriga');

    // remove-child on an already-removed id fails cleanly, zero mutation
    const removeAgain = runCli(['orchestrator', 'remove-child', 'project-heimdall'], env);
    assert.notEqual(removeAgain.code, 0);
    assert.match(removeAgain.stderr, /not a registered child/);
    assert.deepEqual(readTopologyFileDirect(topologyPath), onDisk);

    // ---- Step 5: clear-parent ----
    const clearResult = runCli(['orchestrator', 'clear-parent'], env);
    assert.equal(clearResult.code, 0, clearResult.stderr);
    onDisk = readTopologyFileDirect(topologyPath);
    assert.equal(onDisk.parent, null);
    assert.equal(onDisk.children.length, 1, 'clearing the parent must not touch children');

    // ---- Step 6: final list reflects the root-node-with-one-child state ----
    const finalList = runCli(['orchestrator', 'list'], env);
    assert.match(finalList.stdout, /parent: \(none/);
    assert.match(finalList.stdout, /project-auriga/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: `auriga orchestrator set-parent`/`add-child` require <id>', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'auriga-topology-missing-id-'));
  const topologyPath = join(tmpDir, 'orchestrator-topology.json');
  writeFileSync(topologyPath, JSON.stringify({ parent: null, children: [] }, null, 2) + '\n', 'utf8');
  const env = { AURIGA_ORCHESTRATOR_TOPOLOGY_PATH: topologyPath };
  try {
    const r1 = runCli(['orchestrator', 'set-parent'], env);
    assert.notEqual(r1.code, 0);
    assert.match(r1.stderr, /requires <id>/);

    const r2 = runCli(['orchestrator', 'add-child'], env);
    assert.notEqual(r2.code, 0);
    assert.match(r2.stderr, /requires <id>/);

    assert.deepEqual(readTopologyFileDirect(topologyPath), { parent: null, children: [] }, 'rejected commands must not mutate the file');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
