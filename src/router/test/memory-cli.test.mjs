// CLI-level tests for `auriga memory recall/remember` (t010) — the actual
// `auriga` binary spawned as a real child process (bin/auriga.mjs's main()
// runs unconditionally at import time, so it is never imported directly
// here — see project-cli.test.mjs's own header comment for the fuller
// rationale). AURIGA_MEMORY_ADAPTER=stub (+ AURIGA_STUB_MEMORY_SEED)
// exercises these commands with zero real Mnemosyne service/CLI access,
// mirroring project-cli.test.mjs's AURIGA_BACKLOG_ADAPTER=stub convention —
// standing rule: no live [external system] testing here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(__dirname, '..', 'bin', 'auriga.mjs');

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

test('CLI: `auriga memory recall` requires <query>', () => {
  const result = runCli(['memory', 'recall'], { AURIGA_MEMORY_ADAPTER: 'stub' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /requires <query>/);
});

test('CLI: `auriga memory recall` against the stub adapter finds a seeded hit, scoped by --scope', () => {
  const seed = JSON.stringify({ byScope: { acme: [{ text: 'PANT-4 kept thrashing until the merged-PR guard shipped' }] } });
  const result = runCli(['memory', 'recall', 'thrashing', '--scope', 'acme'], {
    AURIGA_MEMORY_ADAPTER: 'stub',
    AURIGA_STUB_MEMORY_SEED: seed,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 hit/);
  assert.match(result.stdout, /PANT-4 kept thrashing/);
  assert.match(result.stdout, /via=stub/);
});

test('CLI: `auriga memory recall` with no matching hits reports zero results, exits 0 (a miss is not an error)', () => {
  const result = runCli(['memory', 'recall', 'nonexistent-topic', '--scope', 'acme'], {
    AURIGA_MEMORY_ADAPTER: 'stub',
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /no results/);
});

test('CLI: `auriga memory recall` defaults scope to AURIGA_TENANT_ID when --scope is absent', () => {
  const seed = JSON.stringify({ byScope: { 'dostal-tech': [{ text: 'tenant-scoped note' }] } });
  const result = runCli(['memory', 'recall', 'tenant-scoped'], {
    AURIGA_MEMORY_ADAPTER: 'stub',
    AURIGA_STUB_MEMORY_SEED: seed,
    AURIGA_TENANT_ID: 'dostal-tech',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /scope=dostal-tech/);
  assert.match(result.stdout, /1 hit/);
});

test('CLI: `auriga memory remember` requires <text>', () => {
  const result = runCli(['memory', 'remember'], { AURIGA_MEMORY_ADAPTER: 'stub' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /requires <text>/);
});

test('CLI: `auriga memory remember` against the stub adapter succeeds and reports the scope used', () => {
  const result = runCli(['memory', 'remember', 'a real learning worth keeping', '--scope', 'acme', '--tag', 'incident'], {
    AURIGA_MEMORY_ADAPTER: 'stub',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /remembered/);
  assert.match(result.stdout, /scope=acme/);
});
