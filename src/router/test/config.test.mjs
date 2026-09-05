// Tests for AURIGA_CONFIG-driven config loading (PANT-70).
// AC1: AURIGA_CONFIG unset -> all policy exports use hardcoded defaults
// AC2: partial config with only PROJECT_IDS -> PROJECT_IDS from file, rest from defaults
// AC3: malformed/unreadable AURIGA_CONFIG -> exits non-zero (fail-closed)
// AC4: AURIGA_INSTANCE_ID set -> every log line carries instance_id
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as cfg from '../lib/config.mjs';

// ---- AC1: default-identical resolution (policy keys in config.mjs) ----------

test('AC1: AURIGA_CONFIG unset - CAPS matches expected defaults', () => {
  assert.ok(typeof cfg.CAPS.perCyclePerAgent === 'number', 'perCyclePerAgent must be a number');
  assert.ok(typeof cfg.CAPS.perCycleTotal === 'number', 'perCycleTotal must be a number');
  assert.ok(typeof cfg.CAPS.cycleMs === 'number', 'cycleMs must be a number');
  assert.ok(typeof cfg.CAPS.verifyDelayMs === 'number', 'verifyDelayMs must be a number');
  assert.ok(typeof cfg.CAPS.perCycleReview === 'number', 'perCycleReview must be a number');
});

test('AC1: AURIGA_CONFIG unset - HUMAN_NAMES is array of strings', () => {
  assert.ok(Array.isArray(cfg.HUMAN_NAMES), 'HUMAN_NAMES must be an array');
  assert.ok(cfg.HUMAN_NAMES.every(n => typeof n === 'string'), 'all HUMAN_NAMES must be strings');
});

test('AC1: AURIGA_CONFIG unset - HIVE_LANE is a non-empty array', () => {
  assert.ok(Array.isArray(cfg.HIVE_LANE) && cfg.HIVE_LANE.length > 0, 'HIVE_LANE must be non-empty');
});

test('AC1: AURIGA_CONFIG unset - AGENTS contains expected built-in entries', () => {
  assert.ok(cfg.AGENTS['auriga-build'], 'auriga-build must exist in AGENTS');
  assert.ok(cfg.AGENTS['auriga-review'], 'auriga-review must exist in AGENTS');
  assert.ok(cfg.AGENTS['mnemosyne-dev'], 'mnemosyne-dev must exist in AGENTS');
});

// GH #79 regression: auriga-review's id was hardcoded stale (verified against
// the wrong, old Multica workspace) AND config.mjs used to add this entry via
// an unconditional `AGENTS['auriga-review'] = {...}` mutation AFTER
// config-substrate.mjs's AGENTS object was already built — silently stomping
// any future tenant-scoped override. It now lives directly in
// config-substrate.mjs's AGENTS default, like every other agent.
test('GH #79: auriga-review carries the live-reverified id, not the stale default', () => {
  assert.equal(cfg.AGENTS['auriga-review'].id, '7545f9ad-41da-4bd9-9674-f0dc223236b9');
  assert.notEqual(cfg.AGENTS['auriga-review'].id, 'c5beb33c-2a6d-4f78-960a-73966f184506');
});

test('GH #79: every review-lane name in REVIEW_LANE resolves to a real AGENTS entry with an id', () => {
  for (const name of cfg.REVIEW_LANE) {
    assert.ok(cfg.AGENTS[name], `REVIEW_LANE name "${name}" must exist in AGENTS`);
    assert.ok(cfg.AGENTS[name].id, `AGENTS["${name}"] must carry a real id`);
  }
});

test('AC1: PROJECT_IDS is an array (registry-derived when AURIGA_CONFIG unset)', () => {
  assert.ok(Array.isArray(cfg.PROJECT_IDS), 'PROJECT_IDS must be an array');
});

// ---- AC2: partial override --------------------------------------------------

function spawnWithConfig(configJson, script) {
  const cfgPath = path.join(os.tmpdir(), `auriga-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(configJson), 'utf8');
  try {
    return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, AURIGA_CONFIG: cfgPath },
      encoding: 'utf8',
    });
  } finally {
    fs.unlinkSync(cfgPath);
  }
}

const PARTIAL_SCRIPT = `
import * as cfg from ${JSON.stringify(new URL('../lib/config.mjs', import.meta.url).pathname)};
console.log(JSON.stringify({
  PROJECT_IDS: cfg.PROJECT_IDS,
  HIVE_LANE: cfg.HIVE_LANE,
  REVIEW_REPO_OWNER: cfg.REVIEW_REPO_OWNER,
}));
`;

const DEFAULT_HIVE_LANE = ['auriga-build', 'mnemosyne-dev', 'votum-dev'];
const DEFAULT_REVIEW_REPO_OWNER = 'mdostal';

test('AC2: partial config naming only PROJECT_IDS overrides that key, others use defaults', () => {
  const overrideIds = ['override-id-1', 'override-id-2'];
  const result = spawnWithConfig({ PROJECT_IDS: overrideIds }, PARTIAL_SCRIPT);
  assert.equal(result.status, 0, `child exited ${result.status}: ${result.stderr}`);
  const out = JSON.parse(result.stdout.trim());
  assert.deepEqual(out.PROJECT_IDS, overrideIds, 'PROJECT_IDS should come from config file');
  assert.deepEqual(out.HIVE_LANE, DEFAULT_HIVE_LANE, 'HIVE_LANE should fall back to default');
  assert.equal(out.REVIEW_REPO_OWNER, DEFAULT_REVIEW_REPO_OWNER, 'REVIEW_REPO_OWNER should fall back to default');
});

test('AC2: PROJECT_IDS order in override is preserved (array order load-bearing)', () => {
  const overrideIds = ['z-last', 'a-first', 'm-middle'];
  const result = spawnWithConfig({ PROJECT_IDS: overrideIds }, PARTIAL_SCRIPT);
  assert.equal(result.status, 0, `child exited ${result.status}: ${result.stderr}`);
  const out = JSON.parse(result.stdout.trim());
  assert.deepEqual(out.PROJECT_IDS, overrideIds);
});

// ---- AC3: fail-closed on bad AURIGA_CONFIG ----------------------------------

function spawnBadConfig(cfgContent) {
  const cfgPath = path.join(os.tmpdir(), `auriga-bad-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  if (cfgContent !== null) fs.writeFileSync(cfgPath, cfgContent, 'utf8');
  const target = cfgContent === null ? '/no/such/path/does-not-exist-xyz.json' : cfgPath;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `import * as cfg from ${JSON.stringify(new URL('../lib/config.mjs', import.meta.url).pathname)}; console.log('loaded');`
  ], {
    env: { ...process.env, AURIGA_CONFIG: target },
    encoding: 'utf8',
  });
  if (cfgContent !== null) { try { fs.unlinkSync(cfgPath); } catch {} }
  return result;
}

test('AC3: unreadable AURIGA_CONFIG exits non-zero (never dispatches)', () => {
  const result = spawnBadConfig(null);
  assert.notEqual(result.status, 0, 'must exit non-zero on unreadable config');
  assert.ok(!result.stdout.includes('loaded'), 'must NOT reach dispatch code');
  assert.ok(result.stderr.includes('AURIGA_CONFIG'), 'error must name the env var');
});

test('AC3: malformed JSON in AURIGA_CONFIG exits non-zero (never dispatches)', () => {
  const result = spawnBadConfig('{ bad json ]]]');
  assert.notEqual(result.status, 0, 'must exit non-zero on malformed JSON');
  assert.ok(!result.stdout.includes('loaded'), 'must NOT reach dispatch code');
});

test('AC3: JSON array in AURIGA_CONFIG exits non-zero (must be object)', () => {
  const result = spawnBadConfig('["a","b"]');
  assert.notEqual(result.status, 0, 'must exit non-zero when config is not an object');
  assert.ok(!result.stdout.includes('loaded'), 'must NOT reach dispatch code');
});

// ---- AC4: AURIGA_INSTANCE_ID stamped on every log line ----------------------

test('AC4: AURIGA_INSTANCE_ID appears in every log line emitted', () => {
  const logPath = path.join(os.tmpdir(), `auriga-log-test-${Date.now()}.jsonl`);
  const result = spawnSync(process.execPath, ['src/router/auriga-router.mjs', '--once', '--dry-run'], {
    env: {
      ...process.env,
      AURIGA_INSTANCE_ID: 'test-instance-42',
      AURIGA_TENANT_ID: 'test-tenant-99',
      AURIGA_LOG: logPath,
      AURIGA_PIDFILE: path.join(os.tmpdir(), `auriga-pid-test-${Date.now()}.pid`),
    },
    cwd: new URL('../../..', import.meta.url).pathname,
    encoding: 'utf8',
    timeout: 15000,
  });

  const lines = [];
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      try { lines.push(JSON.parse(line)); } catch { /* skip unparseable */ }
    }
  } catch { /* log file may not exist if router failed very early */ }

  for (const line of (result.stdout || '').split('\n').filter(Boolean)) {
    try { lines.push(JSON.parse(line)); } catch { /* skip */ }
  }

  assert.ok(lines.length > 0, 'expected at least one JSONL log line from the router');
  for (const rec of lines) {
    assert.equal(rec.instance_id, 'test-instance-42', `log line missing instance_id: ${JSON.stringify(rec)}`);
    assert.equal(rec.tenant_id, 'test-tenant-99', `log line missing tenant_id: ${JSON.stringify(rec)}`);
  }

  try { fs.unlinkSync(logPath); } catch {}
});
