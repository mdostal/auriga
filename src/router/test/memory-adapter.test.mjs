// Tests for lib/adapters/mnemosyne/memory.mjs (real, HTTP+CLI-fallback
// implementation) and lib/adapters/stub/memory.mjs (in-memory test double)
// against MOCKED fetch/execFile — no live Mnemosyne service or CLI is ever
// invoked, matching this repo's standing "no live [external system] testing"
// rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMnemosyneMemoryAdapter } from '../lib/adapters/mnemosyne/memory.mjs';
import { createStubMemoryAdapter } from '../lib/adapters/stub/memory.mjs';

function fakeFetchOk(json) {
  return async () => ({ ok: true, json: async () => json });
}
function fakeFetchFail(status = 500, body = { error: 'boom' }) {
  return async () => ({ ok: false, status, json: async () => body });
}
function fakeFetchThrows() {
  return async () => { throw new Error('network down'); };
}

// ---- createMnemosyneMemoryAdapter: recall -----------------------------------

test('recall(): service path succeeds -> via=service, real payload shape', async () => {
  const memory = createMnemosyneMemoryAdapter({
    fetchFn: fakeFetchOk({ total_hits: 2, scopes: [{ scope: 'acme', hits: [{ text: 'a' }, { text: 'b' }] }] }),
  });
  const r = await memory.recall('widget', 'acme');
  assert.equal(r.via, 'service');
  assert.equal(r.total_hits, 2);
  assert.equal(r.scopes[0].hits.length, 2);
});

test('recall(): service down, CLI fallback succeeds -> via=cli', async () => {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    cb(null, { stdout: JSON.stringify({ total_hits: 1, scopes: [{ scope: 'acme', hits: [{ text: 'x' }] }] }), stderr: '' });
  };
  const memory = createMnemosyneMemoryAdapter({ fetchFn: fakeFetchThrows(), execFile, cli: 'swarm-memory-test' });
  const r = await memory.recall('widget', 'acme', { hits: 3 });
  assert.equal(r.via, 'cli');
  assert.equal(r.total_hits, 1);
  assert.equal(calls[0].cmd, 'swarm-memory-test');
  assert.ok(calls[0].args.includes('recall'));
  assert.ok(calls[0].args.includes('widget'));
  assert.ok(calls[0].args.includes('--scope'));
  assert.ok(calls[0].args.includes('acme'));
});

test('recall(): both service and CLI fail -> via=none, never throws', async () => {
  const execFile = (cmd, args, opts, cb) => cb(new Error('no such binary'));
  const memory = createMnemosyneMemoryAdapter({ fetchFn: fakeFetchThrows(), execFile });
  const r = await memory.recall('widget', 'acme');
  assert.equal(r.via, 'none');
  assert.equal(r.total_hits, 0);
  assert.deepEqual(r.scopes, []);
  assert.ok(r.service_error);
  assert.ok(r.cli_error);
});

test('recall(): a non-2xx HTTP response is treated as a service failure, not thrown to the caller', async () => {
  const execFile = (cmd, args, opts, cb) => cb(new Error('no such binary'));
  const memory = createMnemosyneMemoryAdapter({ fetchFn: fakeFetchFail(500, { error: 'internal' }), execFile });
  const r = await memory.recall('widget', 'acme');
  assert.equal(r.via, 'none');
  assert.match(r.service_error, /internal/);
});

// ---- createMnemosyneMemoryAdapter: remember ---------------------------------

test('remember(): service path succeeds -> via=service, remembered=true', async () => {
  const memory = createMnemosyneMemoryAdapter({ fetchFn: fakeFetchOk({ remembered: true }) });
  const r = await memory.remember('note text', 'acme', { tag: 'incident' });
  assert.equal(r.via, 'service');
  assert.equal(r.remembered, true);
});

test('remember(): service down -> remembered=false, via=none (no CLI fallback for writes, by design)', async () => {
  const memory = createMnemosyneMemoryAdapter({ fetchFn: fakeFetchThrows() });
  const r = await memory.remember('note text', 'acme');
  assert.equal(r.remembered, false);
  assert.equal(r.via, 'none');
  assert.ok(r.service_error);
});

// ---- createStubMemoryAdapter -------------------------------------------------

test('stub: recall() matches seeded text case-insensitively, scoped', async () => {
  const memory = createStubMemoryAdapter({ byScope: { acme: [{ text: 'The Widget API is deprecated' }, { text: 'unrelated' }] } });
  const r = await memory.recall('widget', 'acme');
  assert.equal(r.via, 'stub');
  assert.equal(r.total_hits, 1);
  assert.equal(r.scopes[0].hits[0].text, 'The Widget API is deprecated');
});

test('stub: recall() against an unseeded scope returns zero hits, not a throw', async () => {
  const memory = createStubMemoryAdapter();
  const r = await memory.recall('anything', 'nonexistent-scope');
  assert.equal(r.total_hits, 0);
});

test('stub: remember() appends to the scope, then recall() finds it (round-trip)', async () => {
  const memory = createStubMemoryAdapter();
  const w = await memory.remember('PANT-4 kept thrashing until the merged-PR guard shipped', 'acme');
  assert.equal(w.remembered, true);
  const r = await memory.recall('thrashing', 'acme');
  assert.equal(r.total_hits, 1);
});
