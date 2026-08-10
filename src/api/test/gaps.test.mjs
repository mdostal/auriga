import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createGapsRouter } from '../gaps.mjs';
import * as core from '../../router/lib/core.mjs';

const CFG = {
  PROJECT_IDS: ['A', 'B'],
  AGENTS: {
    'agent-a': { id: 'AID', runtime: 'codex', maxInflight: 3 },
    'agent-b': { id: 'BID', runtime: 'claude', maxInflight: 1 },
  },
};

const PROJECTS = [
  { id: 'A', title: 'Aligned A' },
  { id: 'B', title: 'Aligned B' },
  { id: 'C', title: 'Orphaned C' },
];

const ISSUES = [
  { identifier: 'A-1', project_id: 'A', assignee_id: 'AID', status: 'in_progress', title: 'has target_repo in desc', description: 'target_repo: mdostal/a\nrest of body', metadata: {} },
  { identifier: 'A-2', project_id: 'A', assignee_id: null, status: 'todo', title: 'has target_repo in metadata', description: 'no yaml here', metadata: { target_repo: 'mdostal/a' } },
  { identifier: 'B-1', project_id: 'B', assignee_id: null, status: 'todo', title: 'missing target_repo entirely', description: 'just prose, no target_repo line', metadata: {} },
];

function fakeMca({ projects = PROJECTS, issues = ISSUES } = {}) {
  return {
    listAllProjects: () => projects,
    listAllIssues: () => issues,
  };
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

test('GET /api/gaps detects an orphaned Multica project not in PROJECT_IDS', async () => {
  const app = express();
  app.use(createGapsRouter(CFG, fakeMca(), core));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/gaps`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.missing_projects, [{ id: 'C', title: 'Orphaned C' }]);
  });
});

test('GET /api/gaps flags only the story with no resolvable target_repo', async () => {
  const app = express();
  app.use(createGapsRouter(CFG, fakeMca(), core));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/gaps`);
    const body = await res.json();
    assert.equal(body.stories_missing_target_repo.length, 1);
    assert.equal(body.stories_missing_target_repo[0].identifier, 'B-1');
  });
});

test('GET /api/gaps reports idle lanes (no inflight, no queued)', async () => {
  const app = express();
  app.use(createGapsRouter(CFG, fakeMca(), core));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/gaps`);
    const body = await res.json();
    // agent-a has an in_progress issue (inflight); agent-b has none at all.
    assert.deepEqual(body.idle_lanes, ['agent-b']);
  });
});

test('GET /api/gaps caches results within the TTL window (second call does not re-query Multica)', async () => {
  const app = express();
  let calls = 0;
  const mca = {
    listAllProjects: () => { calls++; return PROJECTS; },
    listAllIssues: () => ISSUES,
  };
  app.use(createGapsRouter(CFG, mca, core, { ttlMs: 60000 }));
  await withServer(app, async (base) => {
    await fetch(`${base}/api/gaps`);
    await fetch(`${base}/api/gaps`);
    assert.equal(calls, 1);
  });
});

test('GET /api/gaps recomputes after the TTL expires', async () => {
  const app = express();
  let calls = 0;
  const mca = {
    listAllProjects: () => { calls++; return PROJECTS; },
    listAllIssues: () => ISSUES,
  };
  app.use(createGapsRouter(CFG, mca, core, { ttlMs: 1 }));
  await withServer(app, async (base) => {
    await fetch(`${base}/api/gaps`);
    await new Promise((r) => setTimeout(r, 5));
    await fetch(`${base}/api/gaps`);
    assert.equal(calls, 2);
  });
});
