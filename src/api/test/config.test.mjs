import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createConfigRouter } from '../config.mjs';

const CFG = {
  PROJECT_IDS: ['P1', 'P2'],
  PROJECT_NAMES: { P1: 'One', P2: 'Two' },
  AGENTS: { 'agent-a': { id: 'A', runtime: 'codex', maxInflight: 3, repo: 'mdostal/a' } },
  RUNTIME_CAP: { codex: 4 },
  PROJECT_LANE: { P1: ['agent-a'] },
  DEFAULT_LANE: ['agent-a'],
  TREE_AGENT_ATTACHMENTS: {},
  HUMAN_NAMES: ['mathew'],
  CAPS: { perCyclePerAgent: 2, perCycleTotal: 5, cycleMs: 75000, zombieStaleMs: 1200000, verifyDelayMs: 6000 },
};

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('GET /api/config returns the full config snapshot', async () => {
  const app = express();
  app.use(createConfigRouter(CFG));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.PROJECT_IDS, ['P1', 'P2']);
    assert.deepEqual(body.AGENTS, CFG.AGENTS);
    assert.deepEqual(body.CAPS, CFG.CAPS);
    assert.deepEqual(body.HUMAN_NAMES, ['mathew']);
  });
});

test('GET /api/config never leaks fields outside the known config keys', async () => {
  const app = express();
  app.use(createConfigRouter({ ...CFG, SECRET_TOKEN: 'do-not-leak' }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/config`);
    const body = await res.json();
    assert.equal(body.SECRET_TOKEN, undefined);
  });
});
