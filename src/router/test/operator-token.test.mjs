// PANT-1078: Auriga sends Pantheon's operator token on every mutating core-api
// call. Covers the token source (../lib/adapters/pantheon-v2-l2/operator-token.mjs),
// the http-runner headers hook, and the adapters' shared per-process source.
// No live HTTP: curl is a fake execFileSync, and the "shared secrets volume" is
// a temp dir the fake writes the injected file into, the way Portunus would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createOperatorTokenSource, OPERATOR_TOKEN_HEADER, RETRY_MS } from '../lib/adapters/pantheon-v2-l2/operator-token.mjs';
import { makeHttpRun } from '../lib/adapters/pantheon-v2-l2/http-runner.mjs';

const BASE_URL = 'http://core-api.test:3012';
const TOKEN = 'tok-secret-123';

function parseCurl(args) {
  const xIdx = args.indexOf('-X');
  const dIdx = args.indexOf('-d');
  return { method: args[xIdx + 1], url: args[xIdx + 2], body: dIdx === -1 ? undefined : JSON.parse(args[dIdx + 1]) };
}

// A fake curl that answers /api/secrets/inject by writing `PANTHEON_OPERATOR_TOKEN=<token>`
// to the requested path (unless `inject` says otherwise) and every other call with `other`.
function fakeCurl({ inject = () => ({ status: 200, write: `PANTHEON_OPERATOR_TOKEN=${TOKEN}` }), other = () => ({ status: 200, body: {} }) } = {}) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    assert.equal(cmd, 'curl');
    const call = { ...parseCurl(args), args, opts };
    calls.push(call);
    if (call.url.endsWith('/api/secrets/inject')) {
      const r = inject(call);
      if (r instanceof Error) throw r;
      if (r.write !== undefined) writeFileSync(call.body.path, `${r.write}\n`);
      return `${JSON.stringify(r.body ?? { ok: true })}\n${r.status}`;
    }
    const r = other(call);
    return `${r.body === undefined ? '' : JSON.stringify(r.body)}\n${r.status}`;
  };
  return { exec, calls };
}

function secretsDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'auriga-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function source(t, exec, { env = {}, now = () => 0 } = {}) {
  const logs = [];
  const dir = secretsDir(t);
  const src = createOperatorTokenSource({
    exec, baseUrl: BASE_URL, now, log: (l) => logs.push(l),
    env: { PANTHEON_SECRETS_SHARED_DIR: dir, ...env },
  });
  return { src, logs, dir };
}

// ---- operator-token.mjs ------------------------------------------------------------

test('a read never looks up or carries the token', (t) => {
  const { exec, calls } = fakeCurl();
  const { src } = source(t, exec);
  assert.equal(src.tokenFor('GET'), null);
  assert.equal(calls.length, 0);
});

test('the first write resolves the token through POST /api/secrets/inject, then deletes the file', (t) => {
  const { exec, calls } = fakeCurl();
  const { src, logs, dir } = source(t, exec);

  assert.equal(src.tokenFor('POST'), TOKEN);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${BASE_URL}/api/secrets/inject`, 'install-wide: no tenant query');
  const { path, ...rest } = calls[0].body;
  assert.deepEqual(rest, { tags: 'provider=pantheon,kind=operator-token', target: 'file', format: 'env', key: 'PANTHEON_OPERATOR_TOKEN' });
  assert.equal(dirname(path), dir, 'path is directly inside the shared secrets dir');
  assert.deepEqual(readdirSync(dir), [], 'injected file is deleted after reading');
  assert.ok(logs.some((l) => l.includes('operator token resolved')), logs.join('\n'));
  assert.ok(logs.every((l) => !l.includes(TOKEN)), 'the token is never logged');

  // Held in memory: later writes reuse it.
  assert.equal(src.tokenFor('PUT'), TOKEN);
  assert.equal(calls.length, 1);
});

test('every inject uses a fresh path', (t) => {
  let n = 0;
  const { exec, calls } = fakeCurl({ inject: () => ({ status: 503, body: { error: 'portunus down' } }) });
  const logs = [];
  const src = createOperatorTokenSource({
    exec, baseUrl: BASE_URL, log: (l) => logs.push(l), now: () => (n++) * RETRY_MS,
    env: { PANTHEON_SECRETS_SHARED_DIR: secretsDir(t) },
  });
  src.tokenFor('POST');
  src.tokenFor('POST');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].body.path, calls[1].body.path);
});

test('a miss degrades: logged once, no throw, retried on a later write at most once per RETRY_MS', (t) => {
  let clock = 0;
  let fail = true;
  const { exec, calls } = fakeCurl({
    inject: () => (fail ? new Error('curl: (7) Failed to connect to core-api port 3012\nmore') : { status: 200, write: `PANTHEON_OPERATOR_TOKEN=${TOKEN}` }),
  });
  const { src, logs } = source(t, exec, { now: () => clock });

  assert.equal(src.tokenFor('POST'), null);
  assert.equal(src.tokenFor('POST'), null, 'inside the retry window: no second inject');
  assert.equal(calls.length, 1);

  clock += RETRY_MS;
  assert.equal(src.tokenFor('POST'), null);
  assert.equal(calls.length, 2, 'retried after the window');
  assert.equal(logs.filter((l) => l.includes('unavailable')).length, 1, 'the miss is logged once');
  assert.match(logs[0], /Failed to connect/);
  assert.doesNotMatch(logs[0], /more/, 'only the first line of the transport error');

  fail = false;
  clock += RETRY_MS;
  assert.equal(src.tokenFor('POST'), TOKEN, 'recovers once core-api answers');
});

test('inject success with no file in the shared dir (volume not mounted) is a miss, not a crash', (t) => {
  const { exec } = fakeCurl({ inject: () => ({ status: 200 }) });
  const { src, logs } = source(t, exec);
  assert.equal(src.tokenFor('POST'), null);
  assert.match(logs[0], /pantheon-secrets volume mounted/);
});

test('a non-2xx inject is a miss carrying core-api\'s error message', (t) => {
  const { exec } = fakeCurl({ inject: () => ({ status: 404, body: { error: 'no secret matches tags' } }) });
  const { src, logs } = source(t, exec);
  assert.equal(src.tokenFor('POST'), null);
  assert.match(logs[0], /HTTP 404: no secret matches tags/);
});

test('PANTHEON_OPERATOR_TOKEN in the environment wins and never calls the facade', (t) => {
  const { exec, calls } = fakeCurl();
  const { src } = source(t, exec, { env: { PANTHEON_OPERATOR_TOKEN: ' env-tok ' } });
  assert.equal(src.tokenFor('DELETE'), 'env-tok');
  src.invalidate();
  assert.equal(src.tokenFor('POST'), 'env-tok', 'an explicit env token is not dropped on a 401');
  assert.equal(calls.length, 0);
});

test('AURIGA_OPERATOR_TOKEN_SOURCE=none never looks it up', (t) => {
  const { exec, calls } = fakeCurl();
  const { src } = source(t, exec, { env: { AURIGA_OPERATOR_TOKEN_SOURCE: 'none' } });
  assert.equal(src.tokenFor('POST'), null);
  assert.equal(calls.length, 0);
});

test('invalidate() drops a facade token so a later write looks it up again', (t) => {
  let clock = 0;
  const { exec, calls } = fakeCurl();
  const { src } = source(t, exec, { now: () => clock });
  assert.equal(src.tokenFor('POST'), TOKEN);
  src.invalidate();
  clock += RETRY_MS;
  assert.equal(src.tokenFor('POST'), TOKEN);
  assert.equal(calls.length, 2);
});

// ---- http-runner.mjs headers hook ----------------------------------------------------

function fixedToken(value) {
  const state = { invalidated: 0 };
  return { state, tokenFor: (m) => (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? value : null), invalidate: () => { state.invalidated++; } };
}

test('a write carries x-pantheon-operator-token on stdin, never in argv', () => {
  const { exec, calls } = fakeCurl();
  const run = makeHttpRun(exec, BASE_URL, { operatorToken: fixedToken(TOKEN) });

  run('POST', '/api/backlog/issues/PAN-1/status', { status: 'in_review' });

  const { args, opts } = calls[0];
  assert.ok(args.join(' ').includes('-H @-'));
  assert.equal(opts.input, `${OPERATOR_TOKEN_HEADER}: ${TOKEN}\n`);
  assert.equal(opts.stdio[0], 'pipe');
  assert.ok(args.every((a) => !a.includes(TOKEN)), 'token must not appear in curl argv');
});

test('a read goes out exactly as before: no header, no stdin', () => {
  const { exec, calls } = fakeCurl();
  const run = makeHttpRun(exec, BASE_URL, { operatorToken: fixedToken(TOKEN) });

  run('GET', '/api/backlog/issues');

  assert.ok(!calls[0].args.includes('@-'));
  assert.equal(calls[0].opts.input, undefined);
  assert.equal(calls[0].opts.stdio[0], 'ignore');
});

test('a 401 on a write with a token invalidates it and still throws to the caller', () => {
  const { exec } = fakeCurl({ other: () => ({ status: 401, body: { error: 'invalid operator token' } }) });
  const tok = fixedToken(TOKEN);
  const run = makeHttpRun(exec, BASE_URL, { operatorToken: tok });

  assert.throws(() => run('POST', '/api/backlog/issues/PAN-1/assign', { type: 'agent', id: 'a' }), /HTTP 401/);
  assert.equal(tok.state.invalidated, 1);
});

// ---- adapters: one lookup per process, every write carries it ------------------------

let importCounter = 0;

test('backlog + spawn adapters share one lookup and send the token on assign, status, metadata, comments and route/select', async (t) => {
  const dir = secretsDir(t);
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.PANTHEON_SECRETS_SHARED_DIR = dir;
  delete process.env.PANTHEON_OPERATOR_TOKEN;
  delete process.env.AURIGA_OPERATOR_TOKEN_SOURCE;

  const { exec, calls } = fakeCurl({
    other: (c) => (c.url.includes('/api/backlog/agents/') ? { status: 200, body: { id: 'agent-uuid' } } : { status: 200, body: {} }),
  });
  importCounter++;
  const mod = await import(`../lib/adapters/pantheon-v2-l2/index.mjs?operator-token=${importCounter}`);
  const backlog = mod.createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL, exec, tenantId: 'acme' });
  const spawn = mod.createPantheonV2L2SpawnAdapter({ baseUrl: BASE_URL, exec, tenantId: 'acme' });

  spawn.selectRoute('PAN-1', 'build');
  spawn.assignIssue('PAN-1', 'minerva-dev');
  backlog.setIssueMetadata('PAN-1', { k: 'v' });
  backlog.commentOnIssue('PAN-1', 'hi');
  backlog.setIssueStatus('PAN-1', 'in_progress');
  backlog.listAllIssues();

  const injects = calls.filter((c) => c.url.endsWith('/api/secrets/inject'));
  assert.equal(injects.length, 1, 'one lookup per process, shared across adapters');
  assert.ok(!injects[0].url.includes('tenant_id'));

  const writes = calls.filter((c) => !c.url.endsWith('/api/secrets/inject') && c.method !== 'GET');
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url.replace(BASE_URL, '').split('?')[0]}`), [
    'POST /api/route/select',
    'POST /api/backlog/issues/PAN-1/assign',
    'PUT /api/backlog/issues/PAN-1/metadata',
    'POST /api/backlog/issues/PAN-1/comments',
    'POST /api/backlog/issues/PAN-1/status',
  ]);
  for (const w of writes) assert.equal(w.opts.input, `${OPERATOR_TOKEN_HEADER}: ${TOKEN}\n`, `${w.method} ${w.url}`);
  for (const r of calls.filter((c) => c.method === 'GET')) assert.equal(r.opts.input, undefined, r.url);
});
