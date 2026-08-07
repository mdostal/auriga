import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createLanesRouter } from '../lanes.mjs';
import * as core from '../../router/lib/core.mjs';

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
  app.use(createLanesRouter(CFG, fakeMca(ISSUES), core, { pidfile: path.join(os.tmpdir(), 'auriga-lanes-test-missing.pid') }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/lanes`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lanes['agent-a'].inflight, 1);
    assert.equal(body.lanes['agent-a'].queued, 1);
    assert.equal(body.lanes['agent-b'].inflight, 1);
    assert.equal(body.lanes['agent-b'].queued, 0);
    assert.equal(body.runnerStatus, 'stopped');
  });
});

test('GET /api/lanes reports runnerStatus running when the pidfile holds a live pid', async () => {
  const pidfile = path.join(os.tmpdir(), `auriga-lanes-test-${process.pid}.pid`);
  fs.writeFileSync(pidfile, String(process.pid));
  try {
    const app = express();
    app.use(createLanesRouter(CFG, fakeMca([]), core, { pidfile }));
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
  app.use(createLanesRouter(CFG, mca, core, { pidfile: path.join(os.tmpdir(), 'auriga-lanes-test-missing2.pid') }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/lanes`);
    assert.equal(res.status, 502);
  });
});
