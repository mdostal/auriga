import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadExternalConfig } from '../lib/config-loader.mjs';

function tmp(content) {
  const p = path.join(os.tmpdir(), `auriga-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('unset AURIGA_CONFIG returns empty object', () => {
  const orig = process.env.AURIGA_CONFIG;
  delete process.env.AURIGA_CONFIG;
  try {
    assert.deepEqual(loadExternalConfig(), {});
    assert.deepEqual(loadExternalConfig(undefined), {});
  } finally {
    if (orig !== undefined) process.env.AURIGA_CONFIG = orig;
  }
});

test('valid JSON object file returns parsed object', () => {
  const p = tmp(JSON.stringify({ PROJECT_IDS: ['abc', 'def'] }));
  try {
    const result = loadExternalConfig(p);
    assert.deepEqual(result, { PROJECT_IDS: ['abc', 'def'] });
  } finally {
    fs.unlinkSync(p);
  }
});

test('valid partial config (only PROJECT_IDS) returns only that key', () => {
  const ids = ['id-a', 'id-b', 'id-c'];
  const p = tmp(JSON.stringify({ PROJECT_IDS: ids }));
  try {
    const result = loadExternalConfig(p);
    assert.equal(Object.keys(result).length, 1);
    assert.deepEqual(result.PROJECT_IDS, ids);
  } finally {
    fs.unlinkSync(p);
  }
});

// --- failure cases: these call process.exit(1) so we must use a child process ---

function runLoader(envPath, extraEnv = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval',
    `import { loadExternalConfig } from ${JSON.stringify(new URL('../lib/config-loader.mjs', import.meta.url).pathname)}; loadExternalConfig(${JSON.stringify(envPath)});`
  ], { env: { ...process.env, ...extraEnv }, encoding: 'utf8' });
}

test('unreadable AURIGA_CONFIG exits non-zero with clear message', () => {
  const result = runLoader('/no/such/path/auriga-cfg-does-not-exist.json');
  assert.notEqual(result.status, 0, 'should exit non-zero');
  assert.ok(result.stderr.includes('unreadable'), `expected "unreadable" in stderr: ${result.stderr}`);
  assert.ok(result.stderr.includes('AURIGA_CONFIG'), `expected "AURIGA_CONFIG" in stderr: ${result.stderr}`);
});

test('malformed JSON exits non-zero with clear message', () => {
  const p = tmp('{ not valid json }');
  try {
    const result = runLoader(p);
    assert.notEqual(result.status, 0, 'should exit non-zero');
    assert.ok(result.stderr.includes('malformed'), `expected "malformed" in stderr: ${result.stderr}`);
  } finally {
    fs.unlinkSync(p);
  }
});

test('JSON array exits non-zero (must be object)', () => {
  const p = tmp('["a","b"]');
  try {
    const result = runLoader(p);
    assert.notEqual(result.status, 0, 'should exit non-zero');
    assert.ok(result.stderr.includes('JSON object'), `expected "JSON object" in stderr: ${result.stderr}`);
  } finally {
    fs.unlinkSync(p);
  }
});

test('JSON null exits non-zero (must be object)', () => {
  const p = tmp('null');
  try {
    const result = runLoader(p);
    assert.notEqual(result.status, 0, 'should exit non-zero');
    assert.ok(result.stderr.includes('JSON object'), `expected "JSON object" in stderr: ${result.stderr}`);
  } finally {
    fs.unlinkSync(p);
  }
});
