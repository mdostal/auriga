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
  resolveParentBoardConfig,
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

// ---- t015: cross-board reachability fields on setParent/addChild ----------

test('setParent: accepts optional baseUrl/projectId reachability fields', () => {
  const next = setParent(EMPTY, { id: 'firefly-events', baseUrl: 'http://core-api:3012', projectId: 'proj-1' });
  assert.deepEqual(next.parent, { id: 'firefly-events', notes: '', baseUrl: 'http://core-api:3012', projectId: 'proj-1' });
});

test('setParent: omitting baseUrl/projectId produces a parent entry with neither field (not undefined-valued keys)', () => {
  const next = setParent(EMPTY, { id: 'firefly-events' });
  assert.deepEqual(next.parent, { id: 'firefly-events', notes: '' });
  assert.ok(!('baseUrl' in next.parent));
});

test('addChild: accepts optional baseUrl/projectId, preserved on a notes-only re-add (same fallback convention as notes)', () => {
  const before = addChild(EMPTY, { id: 'flayr', baseUrl: 'http://flayr-core-api:3012', projectId: 'flayr-proj' });
  const next = addChild(before, { id: 'flayr', notes: 'updated' });
  assert.deepEqual(next.children[0], {
    id: 'flayr', notes: 'updated', baseUrl: 'http://flayr-core-api:3012', projectId: 'flayr-proj',
  });
});

// ---- t015: resolveParentBoardConfig ----------------------------------------

test('resolveParentBoardConfig: AURIGA_CONFIG\'s parentBoard block wins when both baseUrl and projectId are present there', () => {
  const topology = { parent: { id: 'p', baseUrl: 'http://topology-url:3012', projectId: 'topology-proj' } };
  const externalConfig = { parentBoard: { baseUrl: 'http://config-url:3012', projectId: 'config-proj' } };
  assert.deepEqual(resolveParentBoardConfig(topology, externalConfig), { baseUrl: 'http://config-url:3012', projectId: 'config-proj' });
});

test('resolveParentBoardConfig: falls back to topology.parent\'s own baseUrl/projectId when AURIGA_CONFIG has none', () => {
  const topology = { parent: { id: 'p', baseUrl: 'http://topology-url:3012', projectId: 'topology-proj' } };
  assert.deepEqual(resolveParentBoardConfig(topology, {}), { baseUrl: 'http://topology-url:3012', projectId: 'topology-proj' });
});

test('resolveParentBoardConfig: null when neither source supplies both fields -- no real destination, caller must fall through to human-todo', () => {
  assert.equal(resolveParentBoardConfig({ parent: null }, {}), null);
  assert.equal(resolveParentBoardConfig({ parent: { id: 'p' } }, {}), null, 'a parent id alone (no reachability) is not enough');
  assert.equal(resolveParentBoardConfig({ parent: { id: 'p', baseUrl: 'http://x:3012' } }, {}), null, 'baseUrl without projectId is not enough');
});
