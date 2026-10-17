import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createLanesRouter } from '../lanes.mjs';
import * as core from '../../router/lib/core.mjs';

// Every test pins heartbeatFile so a real /tmp/auriga-router.heartbeat on the
// test host can't leak into runnerStatus.
const NO_HEARTBEAT = path.join(os.tmpdir(), 'auriga-lanes-test-missing.heartbeat');

const CFG = {
  AGENTS: {
    'agent-a': { id: 'A', runtime: 'codex', maxInflight: 3 },
    'agent-b': { id: 'B', runtime: 'claude', maxInflight: 1 },
  },
};

const ISSUES = [
  { identifier: 'X-1', assignee_id: 'A', status: 'in_progress' },
  { identifier: 'X-2', assignee_id: 'A', status: 'todo' },
  { identifier: 'X-3', assignee_id: 'B', status: 'in_progress' },
];

function fakeMca(issues) {
  return { listAllIssues: () => issues };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('GET /api/lanes reflects live inflight/queued router state', async () => {
  const app = express();
  app.use(createLanesRouter(CFG, fakeMca(ISSUES), core, { pidfile: path.join(os.tmpdir(), 'auriga-lanes-test-missing.pid'), heartbeatFile: NO_HEARTBEAT }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/lanes`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lanes['agent-a'].inflight, 1);
    assert.equal(body.lanes['agent-a'].queued, 1);
    assert.equal(body.lanes['agent-b'].inflight, 1);
    assert.equal(body.lanes['agent-b'].queued, 0);
    assert.equal(body.runnerStatus, 'stopped');
    assert.equal(body.runnerLastCycleAt, null);
  });
});

test('GET /api/lanes reports runnerStatus running when the pidfile holds a live pid', async () => {
  const pidfile = path.join(os.tmpdir(), `auriga-lanes-test-${process.pid}.pid`);
  fs.writeFileSync(pidfile, String(process.pid));
  try {
    const app = express();
    app.use(createLanesRouter(CFG, fakeMca([]), core, { pidfile, heartbeatFile: NO_HEARTBEAT }));
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/lanes`);
      const body = await res.json();
      assert.equal(body.runnerStatus, 'running');
    });
  } finally {
    fs.rmSync(pidfile, { force: true });
  }
});

test('GET /api/lanes returns 502 when the Multica query fails', async () => {
  const app = express();
  const mca = { listAllIssues: () => { throw new Error('multica CLI unreachable'); } };
  app.use(createLanesRouter(CFG, mca, core, { pidfile: path.join(os.tmpdir(), 'auriga-lanes-test-missing2.pid'), heartbeatFile: NO_HEARTBEAT }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/lanes`);
    assert.equal(res.status, 502);
  });
});

// PANT-1024: the router runs in another container, so liveness comes from the
// shared heartbeat file, not a pid this process can see.
async function lanesWithHeartbeat({ ageMs, staleMs = 225000, record = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auriga-lanes-hb-'));
  const heartbeatFile = path.join(dir, 'auriga-router.heartbeat');
  const now = Date.now();
  const ts = new Date(now - ageMs).toISOString();
  fs.writeFileSync(heartbeatFile, JSON.stringify({ ts, ...record }) + '\n');
  fs.utimesSync(heartbeatFile, new Date(now - ageMs), new Date(now - ageMs));
  try {
    const app = express();
    app.use(createLanesRouter(CFG, fakeMca([]), core, {
      pidfile: path.join(dir, 'missing.pid'), heartbeatFile, staleMs, now: () => now,
    }));
    let body;
    await withServer(app, async (base) => { body = await (await fetch(`${base}/api/lanes`)).json(); });
    return { body, ts };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('GET /api/lanes: a fresh heartbeat means running, with runnerLastCycleAt from its ts', async () => {
  const { body, ts } = await lanesWithHeartbeat({ ageMs: 30000 });
  assert.equal(body.runnerStatus, 'running');
  assert.equal(body.runnerLastCycleAt, ts);
});

test('GET /api/lanes: a stale heartbeat means stopped, and still reports the last cycle', async () => {
  const { body, ts } = await lanesWithHeartbeat({ ageMs: 300000 });
  assert.equal(body.runnerStatus, 'stopped');
  assert.equal(body.runnerLastCycleAt, ts);
});

test('GET /api/lanes: the stale threshold is configurable', async () => {
  const { body } = await lanesWithHeartbeat({ ageMs: 30000, staleMs: 10000 });
  assert.equal(body.runnerStatus, 'stopped');
});

test('GET /api/lanes: AURIGA_RUNNER_STALE_MS / AURIGA_CYCLE_MS set the threshold from env', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auriga-lanes-hb-env-'));
  const heartbeatFile = path.join(dir, 'hb');
  fs.writeFileSync(heartbeatFile, JSON.stringify({ ts: new Date().toISOString() }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(heartbeatFile, old, old);
  const status = async (env) => {
    const app = express();
    app.use(createLanesRouter(CFG, fakeMca([]), core, { env, pidfile: path.join(dir, 'missing.pid'), heartbeatFile }));
    let s;
    await withServer(app, async (base) => { s = (await (await fetch(`${base}/api/lanes`)).json()).runnerStatus; });
    return s;
  };
  try {
    assert.equal(await status({}), 'running'); // default 3 x 75s
    assert.equal(await status({ AURIGA_CYCLE_MS: '10000' }), 'stopped'); // 3 x 10s < 60s
    assert.equal(await status({ AURIGA_CYCLE_MS: '10000', AURIGA_RUNNER_STALE_MS: '120000' }), 'running');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/lanes: runnerLastCycleAt falls back to the heartbeat mtime when it has no ts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auriga-lanes-hb-mtime-'));
  const heartbeatFile = path.join(dir, 'hb');
  fs.writeFileSync(heartbeatFile, 'not json');
  const now = Date.now();
  const mtime = new Date(now - 5000);
  fs.utimesSync(heartbeatFile, mtime, mtime);
  try {
    const app = express();
    app.use(createLanesRouter(CFG, fakeMca([]), core, { pidfile: path.join(dir, 'missing.pid'), heartbeatFile, now: () => now }));
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/api/lanes`)).json();
      assert.equal(body.runnerStatus, 'running');
      assert.ok(Math.abs(Date.parse(body.runnerLastCycleAt) - mtime.getTime()) < 1000);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
