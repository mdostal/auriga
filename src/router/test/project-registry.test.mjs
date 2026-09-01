// Unit + integration tests for lib/project-registry.mjs (p6-registry-core).
//
// Three concerns, in order:
//   1. Pure derive-function unit tests (deriveProjectNames/Ids/Lane) and
//      read/write unit tests, ALL against injected function doubles — no real
//      filesystem access anywhere in this section (mirrors
//      test/agent-setup.test.mjs's injected-execFileSync convention).
//   2. THE HARD MERGE GATE: config-substrate.mjs's real, live-loaded
//      PROJECT_IDS/PROJECT_LANE (sourced from the actual committed
//      src/router/projects.json) must be byte-identical to today's former
//      hardcoded 4-entry/5-entry literals. This is an integration check
//      against the real file on disk, deliberately — a unit test against a
//      synthetic fixture could never catch a migration bug in the real seed
//      data.
//   3. Graceful-degrade: config-substrate.mjs must not throw when its
//      registry file is missing or malformed. Exercised two ways — a fast
//      unit test of loadRegistryConfig() with an injected failing reader (no
//      real fs), AND a true integration test that re-imports
//      config-substrate.mjs (via a cache-busting query string, mirroring
//      test/spawn-adapter.test.mjs's freshAdapterModule() pattern) against a
//      PRIVATE missing/corrupt fixture file, using the test-only
//      AURIGA_PROJECTS_REGISTRY_PATH env-var override (project-registry.mjs).
//      Deliberately NEVER renames/corrupts the real, committed
//      src/router/projects.json in place — node --test runs test FILES in
//      parallel by default, and that file is read concurrently by other test
//      files/processes (e.g. router-cycle.e2e.test.mjs's `cfg.PROJECT_NAMES`
//      lookups); mutating the real shared file caused exactly that race in
//      an earlier draft of this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  deriveProjectNames,
  deriveProjectIds,
  deriveProjectLane,
  readRegistryFile,
  writeRegistryFile,
  loadRegistryConfig,
  DEFAULT_REGISTRY_PATH,
} from '../lib/project-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_REGISTRY_PATH = join(__dirname, '..', 'projects.json');

// ---- 1a. deriveProjectNames/Ids/Lane: pure functions, synthetic fixture ----

const FIXTURE = {
  dispatch_order: ['id-a', 'id-c', 'id-z'], // id-z is NOT a registered project (defensive-filter case)
  projects: [
    { id: 'id-a', name: 'Alpha', notes: 'n1', lane: ['lane-a'], registered_at: 't1' },
    { id: 'id-b', name: 'Beta', notes: 'n2', lane: [], registered_at: 't2' }, // empty lane -> excluded from PROJECT_LANE
    { id: 'id-c', name: '', notes: '', registered_at: 't3' }, // blank name, no lane field at all
  ],
};

test('deriveProjectNames(): id -> name for every registered project, blank/missing name falls back to id', () => {
  assert.deepEqual(deriveProjectNames(FIXTURE), { 'id-a': 'Alpha', 'id-b': 'Beta', 'id-c': 'id-c' });
});

test('deriveProjectNames(): empty registry -> empty object', () => {
  assert.deepEqual(deriveProjectNames({ projects: [] }), {});
  assert.deepEqual(deriveProjectNames({}), {});
});

test('deriveProjectIds(): dispatch_order, filtered to actually-registered ids, order preserved', () => {
  // id-z is in dispatch_order but not in projects -> defensively dropped.
  // id-b is a registered project but NOT in dispatch_order -> correctly absent.
  assert.deepEqual(deriveProjectIds(FIXTURE), ['id-a', 'id-c']);
});

test('deriveProjectIds(): empty registry -> empty array', () => {
  assert.deepEqual(deriveProjectIds({ projects: [] }), []);
  assert.deepEqual(deriveProjectIds({}), []);
});

test('deriveProjectLane(): only projects with a non-empty lane array are included', () => {
  // id-a has a real lane -> included. id-b has an empty array -> excluded (falls
  // back to DEFAULT_LANE downstream, same as an absent PROJECT_LANE entry today).
  // id-c has no `lane` field at all -> excluded. Independent of dispatch_order —
  // a project can have a lane without being dispatch-eligible (the Minerva case).
  assert.deepEqual(deriveProjectLane(FIXTURE), { 'id-a': ['lane-a'] });
});

test('deriveProjectLane(): empty registry -> empty object', () => {
  assert.deepEqual(deriveProjectLane({ projects: [] }), {});
  assert.deepEqual(deriveProjectLane({}), {});
});

// ---- 1b. readRegistryFile/writeRegistryFile: injected fs double, zero real I/O --

test('readRegistryFile(): calls the injected reader with the given path and JSON-parses the result', () => {
  const calls = [];
  const fakeReadFileSync = (path, encoding) => {
    calls.push({ path, encoding });
    return JSON.stringify({ dispatch_order: ['x'], projects: [{ id: 'x', name: 'X' }] });
  };
  const data = readRegistryFile(fakeReadFileSync, '/fake/path/projects.json');
  assert.deepEqual(calls, [{ path: '/fake/path/projects.json', encoding: 'utf8' }]);
  assert.deepEqual(data, { dispatch_order: ['x'], projects: [{ id: 'x', name: 'X' }] });
});

test('readRegistryFile(): propagates a reader failure (ENOENT-style) — this function does NOT degrade, callers do', () => {
  const throwing = () => { throw new Error('ENOENT: no such file'); };
  assert.throws(() => readRegistryFile(throwing, '/nope.json'), /ENOENT/);
});

test('readRegistryFile(): propagates an invalid-JSON failure — this function does NOT degrade, callers do', () => {
  const badJson = () => 'not { valid json';
  assert.throws(() => readRegistryFile(badJson, '/bad.json'));
});

test('writeRegistryFile(): calls the injected writer with pretty-printed JSON + trailing newline', () => {
  const calls = [];
  const fakeWriteFileSync = (path, contents, encoding) => calls.push({ path, contents, encoding });
  const data = { dispatch_order: [], projects: [] };
  writeRegistryFile(fakeWriteFileSync, data, '/fake/out.json');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/fake/out.json');
  assert.equal(calls[0].encoding, 'utf8');
  assert.equal(calls[0].contents, JSON.stringify(data, null, 2) + '\n');
});

test('DEFAULT_REGISTRY_PATH points at src/router/projects.json, sibling to package.json', () => {
  assert.ok(DEFAULT_REGISTRY_PATH.endsWith('/src/router/projects.json') || DEFAULT_REGISTRY_PATH.endsWith('projects.json'));
  assert.equal(DEFAULT_REGISTRY_PATH, REAL_REGISTRY_PATH);
});

// ---- 1c. loadRegistryConfig(): graceful degrade, injected reader, zero real I/O --

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => { captured += chunk; return original(chunk, ...rest); };
  try {
    const result = fn();
    return { result, captured };
  } finally {
    process.stderr.write = original;
  }
}

// Async variant — the module's top-level stderr.write happens during the
// AWAITED dynamic import() (Node evaluates ESM module graphs asynchronously,
// not synchronously inside the import() call itself), so the capture window
// must stay open across the await, not just the synchronous invocation.
async function captureStderrAsync(asyncFn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => { captured += chunk; return original(chunk, ...rest); };
  try {
    const result = await asyncFn();
    return { result, captured };
  } finally {
    process.stderr.write = original;
  }
}

test('loadRegistryConfig(): a reader that throws (missing file) does NOT throw — logs a warning, returns empty config', () => {
  const throwing = () => { throw new Error('ENOENT: no such file or directory'); };
  const { result, captured } = captureStderr(() => loadRegistryConfig(throwing, '/does/not/exist.json'));
  assert.deepEqual(result, { PROJECT_NAMES: {}, PROJECT_IDS: [], PROJECT_LANE: {} });
  assert.match(captured, /project-registry/i);
  assert.match(captured, /ENOENT/);
});

test('loadRegistryConfig(): a reader returning invalid JSON does NOT throw — logs a warning, returns empty config', () => {
  const badJson = () => '{ this is not valid json,,,';
  const { result, captured } = captureStderr(() => loadRegistryConfig(badJson, '/corrupt.json'));
  assert.deepEqual(result, { PROJECT_NAMES: {}, PROJECT_IDS: [], PROJECT_LANE: {} });
  assert.match(captured, /project-registry/i);
});

test('loadRegistryConfig(): a well-formed reader derives real, non-empty config (sanity check, no degrade path)', () => {
  const goodReader = () => JSON.stringify({
    dispatch_order: ['p1'],
    projects: [{ id: 'p1', name: 'Proj One', lane: ['lane-1'], notes: '', registered_at: 't' }],
  });
  const result = loadRegistryConfig(goodReader, '/fine.json');
  assert.deepEqual(result, {
    PROJECT_NAMES: { p1: 'Proj One' },
    PROJECT_IDS: ['p1'],
    PROJECT_LANE: { p1: ['lane-1'] },
  });
});

// ---- 2. THE HARD MERGE GATE: byte-identical migration, against the REAL file --

test('HARD GATE: config-substrate.mjs\'s real (live-loaded) PROJECT_IDS matches the registry (PANT-59 2026-08-31) — Pantheon Core plus 6 per-god projects, Minerva must NOT appear', async () => {
  const { PROJECT_IDS } = await import('../lib/config-substrate.mjs');
  // PANT-59 (2026-08-31): added 6 per-god projects (confirmed live in workspace f32af269).
  // Pantheon Core remains first; per-god projects follow in order.
  assert.deepEqual(PROJECT_IDS, [
    '032ea2e7-39b0-46d4-804e-57e74f627310', // Pantheon Core
    '8c13f273-ab62-425f-aee2-45e7c324dc09', // Consus (god)
    '9ebce7eb-01db-4274-8829-5472d13b76ae', // Auriga (god)
    '4aa2f07d-79e0-421f-9618-fae642056237', // Heimdall (god)
    '6a21cc72-5ca5-47d2-a791-9db5dce112bb', // Mnemosyne (god)
    '23dd7a13-d801-4d68-9886-ed5a86b3ec40', // Janus (god)
    '0e3d94f1-4846-43b9-90c3-b449d26869d6', // Portunus (god)
  ]);
  assert.ok(!PROJECT_IDS.includes('6327fdaf-789e-4290-ab41-1421957b55c6'), 'Minerva must stay dispatch-ineligible');
});

test('HARD GATE: config-substrate.mjs\'s real (live-loaded) PROJECT_LANE matches the registry (PANT-59 2026-08-31) — Pantheon Core, 6 per-god projects, plus Minerva placeholder', async () => {
  const { PROJECT_LANE } = await import('../lib/config-substrate.mjs');
  assert.deepEqual(PROJECT_LANE, {
    '032ea2e7-39b0-46d4-804e-57e74f627310': ['auriga-build'],              // Pantheon Core
    '8c13f273-ab62-425f-aee2-45e7c324dc09': ['consus-dev', 'auriga-build'],// Consus (god)
    '9ebce7eb-01db-4274-8829-5472d13b76ae': ['auriga-build'],              // Auriga (god)
    '4aa2f07d-79e0-421f-9618-fae642056237': ['heimdall-dev', 'heimdall-dev-codex'], // Heimdall (god)
    '6a21cc72-5ca5-47d2-a791-9db5dce112bb': ['mnemosyne-dev', 'auriga-build'],     // Mnemosyne (god)
    '23dd7a13-d801-4d68-9886-ed5a86b3ec40': ['auriga-build'],              // Janus (god)
    '0e3d94f1-4846-43b9-90c3-b449d26869d6': ['auriga-build'],              // Portunus (god)
    '6327fdaf-789e-4290-ab41-1421957b55c6': ['auriga-dev'],                // Minerva (placeholder)
  });
  assert.equal(Object.keys(PROJECT_LANE).length, 8);
});

test('HARD GATE: config-substrate.mjs\'s real PROJECT_NAMES resolves the 2 remaining registered ids (cosmetic, but must not regress)', async () => {
  const { PROJECT_NAMES } = await import('../lib/config-substrate.mjs');
  assert.equal(PROJECT_NAMES['032ea2e7-39b0-46d4-804e-57e74f627310'], 'Pantheon Core');
  assert.equal(PROJECT_NAMES['6327fdaf-789e-4290-ab41-1421957b55c6'], 'Minerva');
});

// ---- 3. Integration graceful-degrade: the REAL config-substrate.mjs import path,
//         via a PRIVATE fixture path (AURIGA_PROJECTS_REGISTRY_PATH) — the real,
//         committed src/router/projects.json is NEVER touched by these tests.
//         (Earlier draft of this test renamed/corrupted the real file in place;
//         that is unsafe under node --test's default parallel-file execution —
//         other test files/processes reading that same shared path concurrently
//         would transiently see it missing/corrupt, e.g. router-cycle.e2e.test.mjs's
//         `cfg.PROJECT_NAMES` lookups. The env-var override below (same
//         test-only-path-override convention as this repo's existing
//         AURIGA_PIDFILE/AURIGA_LOG/AURIGA_PHIVE_ROOT) makes each test's fixture
//         file private to this process, eliminating the race entirely.)

const REGISTRY_PATH_ENV_VAR = 'AURIGA_PROJECTS_REGISTRY_PATH';

let importCounter = 0;
async function freshConfigSubstrate() {
  importCounter++;
  return import(`../lib/config-substrate.mjs?t=${importCounter}`);
}

// Runs `fn` with AURIGA_PROJECTS_REGISTRY_PATH set to `fixturePath`, restoring
// (or deleting) the env var afterward regardless of outcome.
async function withRegistryPathOverride(fixturePath, fn) {
  const had = REGISTRY_PATH_ENV_VAR in process.env;
  const prev = process.env[REGISTRY_PATH_ENV_VAR];
  process.env[REGISTRY_PATH_ENV_VAR] = fixturePath;
  try {
    return await fn();
  } finally {
    if (had) process.env[REGISTRY_PATH_ENV_VAR] = prev;
    else delete process.env[REGISTRY_PATH_ENV_VAR];
  }
}

test('INTEGRATION: config-substrate.mjs still loads (does not throw) when its registry file is MISSING', async () => {
  const missingPath = join(__dirname, 'fixtures', `does-not-exist-${process.pid}.json`);
  assert.ok(!existsSync(missingPath), 'precondition: fixture path must not exist');
  await withRegistryPathOverride(missingPath, async () => {
    const { captured, result: mod } = await captureStderrAsync(() => freshConfigSubstrate());
    const { PROJECT_NAMES, PROJECT_IDS, PROJECT_LANE } = mod;
    assert.deepEqual(PROJECT_IDS, []);
    assert.deepEqual(PROJECT_NAMES, {});
    assert.deepEqual(PROJECT_LANE, {});
    assert.match(captured, /project-registry/i);
    assert.match(captured, /ENOENT/);
  });
  // Never touched the real file — sanity-check it's still exactly the real one.
  assert.ok(existsSync(REAL_REGISTRY_PATH));
});

test('INTEGRATION: config-substrate.mjs still loads (does not throw) when its registry file is CORRUPTED (invalid JSON)', async () => {
  const corruptPath = join(__dirname, 'fixtures', `corrupt-${process.pid}.json`);
  writeFileSync(corruptPath, '{ this is not valid json,,, [[[', 'utf8');
  try {
    await withRegistryPathOverride(corruptPath, async () => {
      const { captured, result: mod } = await captureStderrAsync(() => freshConfigSubstrate());
      const { PROJECT_NAMES, PROJECT_IDS, PROJECT_LANE } = mod;
      assert.deepEqual(PROJECT_IDS, []);
      assert.deepEqual(PROJECT_NAMES, {});
      assert.deepEqual(PROJECT_LANE, {});
      assert.match(captured, /project-registry/i);
    });
  } finally {
    unlinkSync(corruptPath);
  }
});

test('INTEGRATION: with NO override, config-substrate.mjs loads the REAL committed projects.json (no degrade path taken)', async () => {
  delete process.env[REGISTRY_PATH_ENV_VAR];
  const { captured, result: mod } = await captureStderrAsync(() => freshConfigSubstrate());
  const { PROJECT_IDS } = mod;
  assert.equal(captured, '', 'no warning should be logged when the real file loads cleanly');
  // 7 dispatch-eligible project ids as of PANT-59 (2026-08-31): Pantheon Core
  // plus 6 per-god projects created live in workspace f32af269.
  assert.equal(PROJECT_IDS.length, 7);
});
