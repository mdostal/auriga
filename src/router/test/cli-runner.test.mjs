// Unit tests for the shared cli-runner.mjs module (cleanEnv()/makeRun()),
// extracted out of backlog.mjs and spawn.mjs's previously near-identical
// private copies (p2-adapter-interface follow-up cleanup). execFileSync is
// injected directly as a plain function double here — no node:child_process
// module-mocking/cache-busting needed, since makeRun() takes execFileSync as
// a parameter rather than importing it itself (see cli-runner.mjs's header
// comment for why that design was necessary).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanEnv, makeRun } from '../lib/adapters/multica/cli-runner.mjs';

// ---- cleanEnv(): security-relevant token scrubbing -------------------------

test('cleanEnv(): strips MULTICA_TOKEN/MULTICA_PAT_TOKEN/MULTICA_WORKSPACE_ID from a CLONE of process.env', () => {
  const prevToken = process.env.MULTICA_TOKEN;
  const prevPat = process.env.MULTICA_PAT_TOKEN;
  const prevWs = process.env.MULTICA_WORKSPACE_ID;
  process.env.MULTICA_TOKEN = 'stale-token';
  process.env.MULTICA_PAT_TOKEN = 'stale-pat';
  process.env.MULTICA_WORKSPACE_ID = 'stale-workspace';
  try {
    const e = cleanEnv();
    assert.equal('MULTICA_TOKEN' in e, false);
    assert.equal('MULTICA_PAT_TOKEN' in e, false);
    assert.equal('MULTICA_WORKSPACE_ID' in e, false);
    // Must not mutate the real process.env (a clone, not the original).
    assert.equal(process.env.MULTICA_TOKEN, 'stale-token');
  } finally {
    if (prevToken === undefined) delete process.env.MULTICA_TOKEN; else process.env.MULTICA_TOKEN = prevToken;
    if (prevPat === undefined) delete process.env.MULTICA_PAT_TOKEN; else process.env.MULTICA_PAT_TOKEN = prevPat;
    if (prevWs === undefined) delete process.env.MULTICA_WORKSPACE_ID; else process.env.MULTICA_WORKSPACE_ID = prevWs;
  }
});

test('cleanEnv(): preserves every other env var untouched', () => {
  process.env.__CLI_RUNNER_TEST_MARKER__ = 'kept';
  try {
    const e = cleanEnv();
    assert.equal(e.__CLI_RUNNER_TEST_MARKER__, 'kept');
  } finally {
    delete process.env.__CLI_RUNNER_TEST_MARKER__;
  }
});

// ---- makeRun(): CLI invocation shape ---------------------------------------

test('makeRun(): invokes execFileSync(cli, ["--profile", profile, ...args], {...}) and parses JSON stdout', () => {
  const calls = [];
  const execFileSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return JSON.stringify({ ok: true });
  };
  const run = makeRun(execFileSync, 'multica-test-cli', 'test-profile');

  const result = run(['issue', 'list', '--project', 'PROJ']);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'multica-test-cli');
  assert.deepEqual(calls[0].args, ['--profile', 'test-profile', 'issue', 'list', '--project', 'PROJ']);
  assert.equal(calls[0].opts.encoding, 'utf8');
  assert.equal(calls[0].opts.maxBuffer, 64 * 1024 * 1024);
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(calls[0].opts.env, 'must pass an env option');
});

test('makeRun(): { json: false } returns the raw stdout string instead of parsing it', () => {
  const execFileSync = () => 'plain text output\n';
  const run = makeRun(execFileSync, 'multica-test-cli', 'test-profile');

  const result = run(['issue', 'list'], { json: false });
  assert.equal(result, 'plain text output\n');
});

test('makeRun(): empty/whitespace-only stdout parses to null (JSON mode), never JSON.parse("")', () => {
  const execFileSync = () => '   \n';
  const run = makeRun(execFileSync, 'multica-test-cli', 'test-profile');
  assert.equal(run(['issue', 'list']), null);
});

test('makeRun(): a thrown execFileSync error propagates to the caller (no try/catch of its own)', () => {
  const execFileSync = () => { throw new Error('multica: boom'); };
  const run = makeRun(execFileSync, 'multica-test-cli', 'test-profile');
  assert.throws(() => run(['issue', 'list']), /boom/);
});

test('makeRun(): the env option passed to execFileSync has the three MULTICA_* vars scrubbed', () => {
  process.env.MULTICA_TOKEN = 'stale-token';
  let seenEnv = null;
  try {
    const execFileSync = (cmd, args, opts) => { seenEnv = opts.env; return '{}'; };
    const run = makeRun(execFileSync, 'multica-test-cli', 'test-profile');
    run(['issue', 'list']);
    assert.ok(seenEnv);
    assert.equal('MULTICA_TOKEN' in seenEnv, false);
  } finally {
    delete process.env.MULTICA_TOKEN;
  }
});
