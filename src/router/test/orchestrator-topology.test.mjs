// Tests for lib/orchestrator-topology.mjs (t010) — pure functions against
// injected read/write I/O, exactly mirroring project-registry.test.mjs's
// own injection pattern. Zero real filesystem access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readTopologyFile,
  writeTopologyFile,
  loadRealTopology,
  setParent,
  clearParent,
  addChild,
  removeChild,
} from '../lib/orchestrator-topology.mjs';

const EMPTY = { parent: null, children: [] };

test('readTopologyFile: parses the injected reader\'s JSON', () => {
  const data = readTopologyFile(() => JSON.stringify({ parent: { id: 'top' }, children: [] }));
  assert.deepEqual(data, { parent: { id: 'top' }, children: [] });
});

test('readTopologyFile: propagates a reader failure (missing file) -- callers degrade, this function stays honest', () => {
  assert.throws(() => readTopologyFile(() => { throw new Error('ENOENT'); }));
});

test('writeTopologyFile: serializes pretty-printed JSON with a trailing newline', () => {
  const writes = [];
  writeTopologyFile((path, data) => writes.push({ path, data }), { parent: null, children: [{ id: 'a' }] }, '/fake/path.json');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/fake/path.json');
  assert.ok(writes[0].data.endsWith('\n'));
  assert.deepEqual(JSON.parse(writes[0].data), { parent: null, children: [{ id: 'a' }] });
});

test('loadRealTopology: degrades to EMPTY_TOPOLOGY on a missing/malformed AURIGA_ORCHESTRATOR_TOPOLOGY_PATH, never throws', (t) => {
  const prev = process.env.AURIGA_ORCHESTRATOR_TOPOLOGY_PATH;
  process.env.AURIGA_ORCHESTRATOR_TOPOLOGY_PATH = '/definitely/does/not/exist/topology.json';
  t.after(() => {
    if (prev === undefined) delete process.env.AURIGA_ORCHESTRATOR_TOPOLOGY_PATH;
    else process.env.AURIGA_ORCHESTRATOR_TOPOLOGY_PATH = prev;
  });
  assert.deepEqual(loadRealTopology(), EMPTY);
});

test('setParent: sets a fresh parent on an empty topology', () => {
  const next = setParent(EMPTY, { id: 'meta-orchestrator', notes: 'top of the tree' });
  assert.deepEqual(next, { parent: { id: 'meta-orchestrator', notes: 'top of the tree' }, children: [] });
});

test('setParent: replaces an existing parent, does not mutate the input', () => {
  const before = { parent: { id: 'old', notes: '' }, children: [] };
  const next = setParent(before, { id: 'new' });
  assert.equal(next.parent.id, 'new');
  assert.equal(before.parent.id, 'old', 'input must not be mutated');
});

test('clearParent: sets parent to null, leaves children untouched', () => {
  const before = { parent: { id: 'x' }, children: [{ id: 'child-a' }] };
  const next = clearParent(before);
  assert.equal(next.parent, null);
  assert.deepEqual(next.children, [{ id: 'child-a' }]);
});

test('addChild: appends a new child', () => {
  const next = addChild(EMPTY, { id: 'project-auriga', notes: 'per-project director' });
  assert.deepEqual(next.children, [{ id: 'project-auriga', notes: 'per-project director' }]);
});

test('addChild: idempotent -- updates notes on an already-registered child rather than duplicating', () => {
  const before = { parent: null, children: [{ id: 'project-auriga', notes: 'old notes' }] };
  const next = addChild(before, { id: 'project-auriga', notes: 'new notes' });
  assert.equal(next.children.length, 1);
  assert.equal(next.children[0].notes, 'new notes');
});

test('addChild: re-adding without notes preserves the existing notes rather than blanking them', () => {
  const before = { parent: null, children: [{ id: 'project-auriga', notes: 'keep me' }] };
  const next = addChild(before, { id: 'project-auriga' });
  assert.equal(next.children[0].notes, 'keep me');
});

test('removeChild: removes an existing child by id', () => {
  const before = { parent: null, children: [{ id: 'a' }, { id: 'b' }] };
  const { removed, data } = removeChild(before, 'a');
  assert.equal(removed, true);
  assert.deepEqual(data.children, [{ id: 'b' }]);
});

test('removeChild: a nonexistent id is reported as not-removed, no mutation', () => {
  const before = { parent: null, children: [{ id: 'a' }] };
  const { removed, data } = removeChild(before, 'does-not-exist');
  assert.equal(removed, false);
  assert.deepEqual(data.children, [{ id: 'a' }]);
});
