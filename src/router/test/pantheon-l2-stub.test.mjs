// Unit tests for the REAL pantheon-v2-l2 adapters (../lib/adapters/pantheon-v2-l2/index.mjs)
// against MOCKED curl output — no live HTTP call is ever made. Replaces the prior
// "every method throws NotImplementedError" stub-assertion suite (see git history /
// README.md's "Real, as of the pantheon-owns-multica-board-bridge epic" section for why:
// this directory's own README requires updating its "intentionally unbuilt" statement
// whenever real behavior is added, which this epic did).
//
// Follows backlog-adapter.test.mjs's / spawn-adapter.test.mjs's own established
// module-mocking convention: node:test's `t.mock.module('node:child_process', ...)`
// intercepts execFileSync, and every test dynamically imports the adapter module through
// a cache-busting query string so each test gets its OWN fresh mock binding.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;
async function freshAdapterModule() {
  importCounter++;
  return import(`../lib/adapters/pantheon-v2-l2/index.mjs?t=${importCounter}`);
}

const BASE_URL = 'http://pantheon-test:3012';

// Parses the argv this adapter's http-runner.mjs builds (see that file) back into
// {method, url, body} so test handlers can assert on the LOGICAL request rather than raw argv.
function parseCurlArgs(args) {
  const xIdx = args.indexOf('-X');
  const method = args[xIdx + 1];
  const url = args[xIdx + 2];
  const dIdx = args.indexOf('-d');
  const body = dIdx === -1 ? undefined : JSON.parse(args[dIdx + 1]);
  return { method, url, body };
}

// Builds an execFileSync mock that dispatches to `handler({method, url, body})`, which
// returns either `{ status, body }` (mapped to curl's own "body\nstatus" stdout shape) or an
// Error instance to simulate a transport failure (thrown, matching a real curl non-zero exit).
function makeCurlMock(t, handler) {
  const calls = [];
  const fn = t.mock.fn((cmd, args) => {
    if (cmd !== 'curl') throw new Error('unexpected exec cmd: ' + cmd);
    const parsed = parseCurlArgs(args);
    calls.push({ ...parsed, rawArgs: args });
    const result = handler(parsed);
    if (result instanceof Error) throw result;
    const bodyText = result.body === undefined ? '' : JSON.stringify(result.body);
    return `${bodyText}\n${result.status}`;
  });
  t.mock.module('node:child_process', { exports: { execFileSync: fn } });
  return calls;
}

function rawBoardIssue(overrides = {}) {
  return {
    id: 'issue-1',
    identifier: 'PAN-1',
    title: 'Some issue',
    description: 'desc',
    status: 'todo',
    labels: ['a-label'],
    assignee: { type: 'agent', id: 'agent-uuid-1' },
    project: 'proj-1',
    parentId: null,
    metadata: { foo: 1 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---- BacklogAdapter -------------------------------------------------------------------

test('listIssues() GETs the project-scoped route and maps back to raw, snake_case fields', async (t) => {
  const calls = makeCurlMock(t, () => ({ status: 200, body: { issues: [rawBoardIssue()] } }));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  const issues = backlog.listIssues('proj-1');

  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/api\/backlog\/issues\?project=proj-1$/);
  assert.deepEqual(issues, [{
    id: 'issue-1', identifier: 'PAN-1', title: 'Some issue', description: 'desc', status: 'todo',
    labels: ['a-label'], assignee_id: 'agent-uuid-1', assignee_type: 'agent', project_id: 'proj-1',
    parent_issue_id: null, metadata: { foo: 1 }, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }]);
});

test('listAllProjectIds() returns a single sentinel (Pantheon backlog is board-wide, not project-scoped)', async (t) => {
  makeCurlMock(t, () => new Error('should never be called — listAllProjectIds is pure'));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  assert.deepEqual(backlog.listAllProjectIds(), ['__pantheon_board__']);
});

test('listAllIssues() ignores its scanIds argument and does one unfiltered, board-wide GET', async (t) => {
  const calls = makeCurlMock(t, () => ({ status: 200, body: { issues: [rawBoardIssue({ id: 'a' }), rawBoardIssue({ id: 'b' })] } }));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  const issues = backlog.listAllIssues(['ignored-project-a', 'ignored-project-b']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE_URL}/api/backlog/issues`);
  assert.deepEqual(issues.map((i) => i.id), ['a', 'b']);
});

test('getIssueRuns() unwraps {runs} and degrades to [] on failure', async (t) => {
  const calls = makeCurlMock(t, () => ({ status: 200, body: { runs: [{ id: 'run-1', status: 'running' }] } }));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  const runs = backlog.getIssueRuns('PAN-1');

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${BASE_URL}/api/backlog/issues/PAN-1/runs`);
  assert.deepEqual(runs, [{ id: 'run-1', status: 'running' }]);
});

test('getIssueRuns() degrades gracefully (returns []) when the request fails', async (t) => {
  makeCurlMock(t, () => new Error('connection refused'));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  assert.deepEqual(backlog.getIssueRuns('PAN-1'), []);
});

test('getIssuePullRequests() unwraps {pull_requests} and degrades to [] on failure', async (t) => {
  makeCurlMock(t, () => ({ status: 200, body: { pull_requests: [{ number: 42 }] } }));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  assert.deepEqual(backlog.getIssuePullRequests('PAN-1'), [{ number: 42 }]);
});

test('setIssueStatus() POSTs {status} and PROPAGATES a failure (write methods never degrade)', async (t) => {
  const calls = makeCurlMock(t, () => new Error('HTTP 502'));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  assert.throws(() => backlog.setIssueStatus('PAN-1', 'in_review'), /HTTP 502/);
});

test('setIssueStatus() success path sends the right method/url/body', async (t) => {
  const calls = makeCurlMock(t, () => ({ status: 204 }));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  backlog.setIssueStatus('PAN-1', 'in_review');

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${BASE_URL}/api/backlog/issues/PAN-1/status`);
  assert.deepEqual(calls[0].body, { status: 'in_review' });
});

test('commentOnIssue() posts {body, author: "auriga"} and degrades to null on failure', async (t) => {
  makeCurlMock(t, () => new Error('timeout'));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  assert.equal(backlog.commentOnIssue('PAN-1', 'hello'), null);
});

test('commentOnIssue() success path sends the right body', async (t) => {
  const calls = makeCurlMock(t, () => ({ status: 201, body: { id: 'c1' } }));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  backlog.commentOnIssue('PAN-1', 'hello');

  assert.deepEqual(calls[0].body, { body: 'hello', author: 'auriga' });
});

// ---- SpawnAdapter ----------------------------------------------------------------------

test('describeLanes(): unchanged from the multica-direct adapter -- zero Pantheon dependency', async (t) => {
  makeCurlMock(t, () => new Error('describeLanes must never make a request'));
  const { createPantheonV2L2SpawnAdapter } = await freshAdapterModule();
  const spawn = createPantheonV2L2SpawnAdapter({
    projectLane: { p1: ['agent-a'] },
    defaultLane: ['agent-b'],
    hiveLane: ['agent-c'],
    reviewLane: ['agent-d'],
    runtimeCap: { claude: 2 },
  });

  assert.deepEqual(spawn.describeLanes(), {
    projectLane: { p1: ['agent-a'] },
    defaultLane: ['agent-b'],
    hiveLane: ['agent-c'],
    reviewLane: ['agent-d'],
    runtimeCap: { claude: 2 },
  });
});

test('assignIssue() resolves the agent NAME to an id via /api/backlog/agents/:name, then assigns by id', async (t) => {
  const calls = makeCurlMock(t, ({ url }) => {
    if (url.includes('/api/backlog/agents/')) return { status: 200, body: { name: 'auriga-dev', id: 'agent-uuid-9' } };
    return { status: 204 };
  });
  const { createPantheonV2L2SpawnAdapter } = await freshAdapterModule();
  const spawn = createPantheonV2L2SpawnAdapter({ baseUrl: BASE_URL });

  spawn.assignIssue('PAN-1', 'auriga-dev');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${BASE_URL}/api/backlog/agents/auriga-dev`);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, `${BASE_URL}/api/backlog/issues/PAN-1/assign`);
  assert.deepEqual(calls[1].body, { type: 'agent', id: 'agent-uuid-9' });
});

test('assignIssue() throws when the agent name does not resolve, without ever calling assign', async (t) => {
  const calls = makeCurlMock(t, () => ({ status: 404, body: { error: 'no agent named "ghost"' } }));
  const { createPantheonV2L2SpawnAdapter } = await freshAdapterModule();
  const spawn = createPantheonV2L2SpawnAdapter({ baseUrl: BASE_URL });

  assert.throws(() => spawn.assignIssue('PAN-1', 'ghost'), /HTTP 404/);
  assert.equal(calls.length, 1); // resolve attempt only — assign never fired
});

test('rerunIssue() POSTs with no body and propagates a failure', async (t) => {
  const calls = makeCurlMock(t, () => ({ status: 204 }));
  const { createPantheonV2L2SpawnAdapter } = await freshAdapterModule();
  const spawn = createPantheonV2L2SpawnAdapter({ baseUrl: BASE_URL });

  spawn.rerunIssue('PAN-1');

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${BASE_URL}/api/backlog/issues/PAN-1/rerun`);
  assert.equal(calls[0].body, undefined);
});

test('a bodyless request never sends a content-type header -- Pantheon\'s real Fastify server rejects content-type + empty body (FST_ERR_CTP_EMPTY_JSON_BODY, confirmed live 2026-08-28)', async (t) => {
  const calls = makeCurlMock(t, () => ({ status: 204 }));
  const { createPantheonV2L2SpawnAdapter } = await freshAdapterModule();
  const spawn = createPantheonV2L2SpawnAdapter({ baseUrl: BASE_URL });

  spawn.rerunIssue('PAN-1');

  assert.ok(
    !calls[0].rawArgs.includes('content-type: application/json'),
    'a bodyless curl call must not set content-type at all',
  );
});

test('unassignIssue() POSTs to the unassign route and propagates a failure', async (t) => {
  const calls = makeCurlMock(t, () => ({ status: 204 }));
  const { createPantheonV2L2SpawnAdapter } = await freshAdapterModule();
  const spawn = createPantheonV2L2SpawnAdapter({ baseUrl: BASE_URL });

  spawn.unassignIssue('PAN-1');

  assert.equal(calls[0].url, `${BASE_URL}/api/backlog/issues/PAN-1/unassign`);
});

test('dispatch(): a run that started within the verify delay does NOT force-rerun', async (t) => {
  const calls = makeCurlMock(t, ({ url }) => {
    if (url.includes('/api/backlog/agents/')) return { status: 200, body: { id: 'agent-uuid-1' } };
    if (url.endsWith('/assign')) return { status: 204 };
    if (url.endsWith('/runs')) return { status: 200, body: { runs: [{ id: 'run-1', status: 'running' }] } };
    throw new Error('unexpected url: ' + url);
  });
  const { createPantheonV2L2SpawnAdapter } = await freshAdapterModule();
  const spawn = createPantheonV2L2SpawnAdapter({ baseUrl: BASE_URL, sleep: () => {} });

  const result = spawn.dispatch({ identifier: 'PAN-1' }, 'auriga-dev');

  assert.equal(result.assigned, true);
  assert.equal(result.forcedRerun, false);
  assert.ok(!calls.some((c) => c.url.endsWith('/rerun')));
});

test('dispatch(): no run row within the verify delay force-reruns', async (t) => {
  const calls = makeCurlMock(t, ({ url }) => {
    if (url.includes('/api/backlog/agents/')) return { status: 200, body: { id: 'agent-uuid-1' } };
    if (url.endsWith('/assign')) return { status: 204 };
    if (url.endsWith('/runs')) return { status: 200, body: { runs: [] } };
    if (url.endsWith('/rerun')) return { status: 204 };
    throw new Error('unexpected url: ' + url);
  });
  const { createPantheonV2L2SpawnAdapter } = await freshAdapterModule();
  const spawn = createPantheonV2L2SpawnAdapter({ baseUrl: BASE_URL, sleep: () => {} });

  const result = spawn.dispatch({ identifier: 'PAN-1' }, 'auriga-dev');

  assert.equal(result.forcedRerun, true);
  assert.ok(calls.some((c) => c.url.endsWith('/rerun')));
});

test('dispatch(): an assign failure short-circuits — never sleeps, never checks runs, never reruns, never throws', async (t) => {
  const sleep = t.mock.fn(() => {});
  makeCurlMock(t, ({ url }) => {
    if (url.includes('/api/backlog/agents/')) return { status: 200, body: { id: 'agent-uuid-1' } };
    if (url.endsWith('/assign')) return new Error('HTTP 429 rate limited');
    throw new Error('unexpected url: ' + url);
  });
  const { createPantheonV2L2SpawnAdapter } = await freshAdapterModule();
  const spawn = createPantheonV2L2SpawnAdapter({ baseUrl: BASE_URL, sleep });

  const result = spawn.dispatch({ identifier: 'PAN-1' }, 'auriga-dev');

  assert.equal(result.assigned, false);
  assert.match(result.assignError, /HTTP 429/);
  assert.equal(sleep.mock.calls.length, 0);
});

// ---- SpawnAdapter: still no provisioning method — see spawn-adapter.mjs's
// header comment. The real implementation must not add one either. ----

test('createPantheonV2L2SpawnAdapter(): has no provision/createEnvironment/bootstrap method', async () => {
  const { createPantheonV2L2SpawnAdapter } = await freshAdapterModule();
  const spawn = createPantheonV2L2SpawnAdapter();
  assert.equal(spawn.provision, undefined);
  assert.equal(spawn.createEnvironment, undefined);
  assert.equal(spawn.bootstrap, undefined);
});
