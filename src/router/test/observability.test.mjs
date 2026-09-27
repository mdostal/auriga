// PANT-817: container-ready runtime signals — stdout/file JSONL sink, the
// per-cycle `cycle_summary` event, the heartbeat file + healthcheck, and the
// POSIX supervisor. Drives the REAL cycle() against in-memory adapters, same
// approach as router-cycle.e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cycle } from '../auriga-router.mjs';
import * as cfg from '../lib/config.mjs';
import { checkHeartbeat, createLogger, defaultHeartbeatFile, passForEvent, SUMMARY_PASSES } from '../lib/observability.mjs';
import { createLogSink } from './support/mock-mca.mjs';

const NOOP_SLEEP = async () => {};
const ROUTER_DIR = new URL('..', import.meta.url).pathname;
const PANTHEON_CORE = Object.entries(cfg.PROJECT_NAMES).find(([, n]) => n === 'Pantheon Core')[0];
// No parent board configured, so hand-up stays off and no real config is read.
const TOPOLOGY_OPTS = { loadTopology: () => ({ parent: null, children: [] }), loadExternalConfig: () => ({}) };

let seq = 7000;
function makeIssue(overrides = {}) {
  const n = seq++;
  return {
    id: `id-${n}`, identifier: `OBS-${n}`, number: n, title: `story ${n}`, description: '',
    labels: [], status: 'todo', assignee_id: null, parent_issue_id: 'fake-parent', metadata: {},
    project_id: PANTHEON_CORE, ...overrides,
  };
}

// Minimal backlog/spawn pair sharing one board. assign/rerun synthesize an
// active run so the inline verify step sees a started run.
// opts.throwPrsFor / opts.throwRunsFor: identifiers whose PR / run lookups throw.
function createAdapters(board, opts = {}) {
  const runs = {};
  const throwPrsFor = opts.throwPrsFor || new Set();
  const throwRunsFor = opts.throwRunsFor || new Set();
  const addRun = (id) => { runs[id] = [...(runs[id] || []), { status: 'in_progress', created_at: new Date().toISOString() }]; };
  const backlog = {
    listAllProjectIds: () => [],
    listAllIssues: (ids) => board.filter((i) => ids.includes(i.project_id)),
    getIssueRuns: (id) => {
      if (throwRunsFor.has(id)) throw new Error(`runs lookup failed for ${id}`);
      return runs[id] || [];
    },
    getIssuePullRequests: (id) => {
      if (throwPrsFor.has(id)) throw new Error(`pr lookup failed for ${id}`);
      return [];
    },
    setIssueStatus: (id, status) => { const i = board.find((x) => x.identifier === id); if (i) i.status = status; },
    commentOnIssue: () => {},
    setIssueMetadata: () => {},
  };
  const spawn = {
    assignIssue: (id, agent) => { const i = board.find((x) => x.identifier === id); if (i) i.assignee_id = cfg.AGENTS[agent]?.id; addRun(id); },
    rerunIssue: (id) => addRun(id),
    unassignIssue: (id) => { const i = board.find((x) => x.identifier === id); if (i) i.assignee_id = null; },
    describeLanes: () => ({}),
  };
  return { backlog, spawn };
}

// Re-derives per-pass/error counts from the events a cycle actually emitted.
function recount(events) {
  const passes = Object.fromEntries(SUMMARY_PASSES.map((p) => [p, 0]));
  let errors = 0;
  for (const e of events) {
    if (e.event === 'cycle_summary') continue;
    const pass = passForEvent(e.event, e);
    if (pass) passes[pass] += 1;
    if (e.event.endsWith('_error')) errors += 1;
  }
  return { passes, errors };
}

// Captures everything written to process.stdout while fn runs.
async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => { chunks.push(String(chunk)); const cb = rest.find((r) => typeof r === 'function'); if (cb) cb(); return true; };
  try { await fn(); } finally { process.stdout.write = orig; }
  return chunks.join('').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return Promise.resolve().then(fn).finally(restore);
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auriga-obs-'));

// ---- log sink ----------------------------------------------------------------

test('AURIGA_LOG unset: cycle() writes its JSONL (incl. cycle_summary) to stdout', async () => {
  const { backlog, spawn } = createAdapters([makeIssue()]);
  await withEnv({ AURIGA_LOG: undefined }, async () => {
    const lines = await captureStdout(() => cycle({ backlog, spawn, cfg, sleep: NOOP_SLEEP, ...TOPOLOGY_OPTS }));
    assert.ok(lines.some((l) => l.event === 'scan'), 'scan event on stdout');
    assert.equal(lines.filter((l) => l.event === 'cycle_summary').length, 1, 'one cycle_summary on stdout');
  });
});

test('AURIGA_LOG set: cycle() writes its JSONL to the file and nothing to stdout', async () => {
  const logFile = path.join(tmpDir(), 'router.jsonl');
  const { backlog, spawn } = createAdapters([makeIssue()]);
  await withEnv({ AURIGA_LOG: logFile }, async () => {
    const lines = await captureStdout(() => cycle({ backlog, spawn, cfg, sleep: NOOP_SLEEP, ...TOPOLOGY_OPTS }));
    assert.deepEqual(lines, [], 'no JSONL on stdout');
  });
  const fileLines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(fileLines.some((l) => l.event === 'scan'));
  assert.equal(fileLines.filter((l) => l.event === 'cycle_summary').length, 1);
});

test('createLogger keeps AURIGA_INSTANCE_ID/AURIGA_TENANT_ID stamping, explicit tenant_id wins', () => {
  const out = [];
  const log = createLogger({ env: { AURIGA_INSTANCE_ID: 'inst-1', AURIGA_TENANT_ID: 'ten-1' }, stdout: { write: (s) => out.push(JSON.parse(s)) } });
  log('a', {});
  log('b', { tenant_id: 'other' });
  assert.equal(out[0].instance_id, 'inst-1');
  assert.equal(out[0].tenant_id, 'ten-1');
  assert.equal(out[1].tenant_id, 'other');
});

test('createLogger falls back to stdout when the AURIGA_LOG file is unwritable', () => {
  const out = [];
  const log = createLogger({ env: { AURIGA_LOG: path.join(tmpDir(), 'missing-dir', 'x.jsonl') }, stdout: { write: (s) => out.push(s) } });
  log('a', { n: 1 });
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]).event, 'a');
});

// ---- cycle_summary -----------------------------------------------------------

test('exactly one cycle_summary per cycle; per-pass and error counts match the emitted events', async () => {
  const review = makeIssue({ status: 'in_review' });
  const board = [makeIssue(), makeIssue(), review];
  const { backlog, spawn } = createAdapters(board, { throwPrsFor: new Set([review.identifier]) });
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP, ...TOPOLOGY_OPTS });

  const summaries = log.byEvent('cycle_summary');
  assert.equal(summaries.length, 1);
  const [s] = summaries;
  assert.equal(log.events.at(-1).event, 'cycle_summary', 'summary is the last event of the cycle');
  const { passes, errors } = recount(log.events);
  assert.deepEqual(s.passes, passes);
  assert.equal(s.errors, errors);
  assert.ok(s.errors >= 1, 'the prs_fetch_error is counted');
  assert.equal(s.passes.routed, log.byEvent('route').length);
  assert.ok(s.passes.routed >= 1);
  assert.equal(s.issues_scanned, board.length);
  assert.equal(s.assigned, result.assigned);
  assert.equal(s.todo, result.todo);
  assert.equal(s.picked, result.picked);
  assert.equal(s.aborted, false);
  assert.equal(s.dry_run, false);
  assert.ok(Array.isArray(s.blocked_runtimes));
  assert.ok(Number.isInteger(s.duration_ms) && s.duration_ms >= 0);
  assert.deepEqual(Object.keys(s.passes).sort(), [...SUMMARY_PASSES].sort());
});

test('a cycle where a pass throws still emits exactly one cycle_summary (aborted), then rethrows', async () => {
  const review = makeIssue({ status: 'in_review' });
  const board = [makeIssue(), review];
  // PR lookup fails (caught -> prs_fetch_error); the review pass's run lookup
  // then throws uncaught and aborts the cycle.
  const { backlog, spawn } = createAdapters(board, {
    throwPrsFor: new Set([review.identifier]),
    throwRunsFor: new Set([review.identifier]),
  });
  const log = createLogSink();

  await assert.rejects(
    cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP, ...TOPOLOGY_OPTS }),
    /runs lookup failed/,
  );

  const summaries = log.byEvent('cycle_summary');
  assert.equal(summaries.length, 1);
  const [s] = summaries;
  const { passes, errors } = recount(log.events);
  assert.equal(s.aborted, true);
  assert.match(s.abort_error, /runs lookup failed/);
  assert.deepEqual(s.passes, passes);
  assert.equal(s.errors, errors + 1, '*_error events plus the abort');
  assert.equal(s.issues_scanned, board.length);
  assert.equal(s.assigned, null);
});

test('dry-run cycles report dry_run and count decisions that were not applied', async () => {
  const { backlog, spawn } = createAdapters([makeIssue()]);
  const log = createLogSink();
  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP, dryRun: true, ...TOPOLOGY_OPTS });
  const [s] = log.byEvent('cycle_summary');
  assert.equal(s.dry_run, true);
  assert.equal(s.passes.routed, 1);
  assert.equal(s.assigned, 0);
});

test('passForEvent maps every counted decision event to its pass', () => {
  assert.equal(passForEvent('advance', { from: 'blocked', to: 'todo' }), 'unblocked');
  assert.equal(passForEvent('advance', { to: 'done', kind: 'parent-rollup' }), 'parent_rollup');
  assert.equal(passForEvent('advance', { to: 'in_review' }), 'in_review');
  assert.equal(passForEvent('advance', { to: 'done', kind: 'verified-done' }), 'verified_done');
  assert.equal(passForEvent('advance', { from: 'changes_requested', to: 'todo' }), 'changeback');
  assert.equal(passForEvent('cascade_dispatch', {}), 'cascade');
  assert.equal(passForEvent('zombie', {}), 'zombie');
  assert.equal(passForEvent('zombie_give_up', {}), 'zombie');
  assert.equal(passForEvent('assigned_idle', {}), 'assigned_idle');
  assert.equal(passForEvent('assigned_idle_unassign', {}), 'assigned_idle');
  assert.equal(passForEvent('archived_agent_unassign', {}), 'assigned_idle');
  assert.equal(passForEvent('review', {}), 'review');
  assert.equal(passForEvent('route', {}), 'routed');
  assert.equal(passForEvent('hand_up', {}), 'hand_up');
  assert.equal(passForEvent('scan', {}), null);
  assert.equal(passForEvent('verify_ok', {}), null);
});

// ---- heartbeat + healthcheck ---------------------------------------------------

test('the heartbeat file is rewritten every cycle with the cycle_summary timestamp', async () => {
  const heartbeatFile = path.join(tmpDir(), 'auriga-router.heartbeat');
  const { backlog, spawn } = createAdapters([makeIssue(), makeIssue()]);
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP, heartbeatFile, ...TOPOLOGY_OPTS });
  const first = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
  assert.equal(first.ts, log.byEvent('cycle_summary')[0].ts);
  assert.equal(first.pid, process.pid);

  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(heartbeatFile, old, old);
  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP, heartbeatFile, ...TOPOLOGY_OPTS });
  const second = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
  assert.equal(second.ts, log.byEvent('cycle_summary')[1].ts);
  assert.ok(fs.statSync(heartbeatFile).mtimeMs > old.getTime() + 1000, 'mtime refreshed by the second cycle');
  assert.deepEqual(fs.readdirSync(path.dirname(heartbeatFile)), ['auriga-router.heartbeat'], 'no temp files left behind');
});

test('the heartbeat is also written when the cycle aborts', async () => {
  const heartbeatFile = path.join(tmpDir(), 'hb');
  const review = makeIssue({ status: 'in_review' });
  const { backlog, spawn } = createAdapters([review], { throwRunsFor: new Set([review.identifier]) });
  await assert.rejects(cycle({ backlog, spawn, cfg, log: createLogSink(), sleep: NOOP_SLEEP, heartbeatFile, ...TOPOLOGY_OPTS }));
  assert.equal(JSON.parse(fs.readFileSync(heartbeatFile, 'utf8')).aborted, true);
});

test('defaultHeartbeatFile: AURIGA_HEARTBEAT_FILE wins, else next to the pidfile', () => {
  assert.equal(defaultHeartbeatFile({ AURIGA_HEARTBEAT_FILE: '/x/hb' }), '/x/hb');
  assert.equal(defaultHeartbeatFile({ AURIGA_PIDFILE: '/run/auriga/router.pid' }), '/run/auriga/auriga-router.heartbeat');
  assert.equal(defaultHeartbeatFile({}), '/tmp/auriga-router.heartbeat');
});

test('checkHeartbeat: missing, fresh and stale', () => {
  const file = path.join(tmpDir(), 'hb');
  assert.equal(checkHeartbeat(file, 1000).ok, false);
  fs.writeFileSync(file, '{}');
  assert.equal(checkHeartbeat(file, 60_000).ok, true);
  assert.equal(checkHeartbeat(file, 1000, Date.now() + 5000).ok, false);
});

test('bin/healthcheck.mjs exits 0 on a fresh heartbeat, 1 on a stale or missing one', () => {
  const file = path.join(tmpDir(), 'hb');
  const run = (extra = {}) => spawnSync(process.execPath, [path.join(ROUTER_DIR, 'bin/healthcheck.mjs')], {
    env: { ...process.env, AURIGA_HEARTBEAT_FILE: file, AURIGA_CYCLE_MS: '1000', ...extra }, encoding: 'utf8',
  });
  assert.equal(run().status, 1, 'missing heartbeat is unhealthy');
  fs.writeFileSync(file, '{}');
  assert.equal(run().status, 0, 'fresh heartbeat is healthy');
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(file, old, old);
  assert.equal(run().status, 1, 'older than 3 x AURIGA_CYCLE_MS is unhealthy');
  assert.equal(run({ AURIGA_HEALTH_MAX_AGE_MS: '60000' }).status, 0, 'AURIGA_HEALTH_MAX_AGE_MS overrides the default');
});

// ---- supervisor.sh -------------------------------------------------------------

const SUPERVISOR = path.join(ROUTER_DIR, 'supervisor.sh');

test('supervisor.sh is POSIX sh (parses under /bin/sh, no zsh/bash shebang)', () => {
  assert.match(fs.readFileSync(SUPERVISOR, 'utf8').split('\n')[0], /^#!\/bin\/sh$/);
  const res = spawnSync('/bin/sh', ['-n', SUPERVISOR], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
});

test('supervisor.sh has no host-specific default paths', () => {
  const src = fs.readFileSync(SUPERVISOR, 'utf8');
  assert.doesNotMatch(src, /\.local\/share\/mise|Documents\/work|\$HOME/);
});

test('supervisor.sh fails loudly when node is not on PATH', () => {
  const env = { PATH: '/nonexistent', AURIGA_PIDFILE: path.join(tmpDir(), 'router.pid') };
  const res = spawnSync('/bin/sh', [SUPERVISOR], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /node not found/);
});
