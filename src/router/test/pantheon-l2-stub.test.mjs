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

// ---- listCandidatePullRequests() -- Pantheon GitHub facade (PANT-133) ----
// PR discovery now routes through Pantheon's GitHub facade (GET
// /api/github/repos and GET /api/github/repos/:owner/:repo/pulls) via the
// same curl-based `exec` injection the other tests above use — no `ghExec`
// parameter and no gh binary. All three tests inject `exec` directly
// (createPantheonV2L2BacklogAdapter({ exec })) and parse the URL from curl's
// argv to dispatch the right fake response, matching makeCurlMock's own
// argv-parsing shape.

function makePantheonGhExec(t, handler) {
  const calls = [];
  const fn = t.mock.fn((cmd, args) => {
    if (cmd !== 'curl') throw new Error('unexpected exec cmd: ' + cmd);
    // Extract the URL from curl args (the first bare arg after -X GET)
    const xIdx = args.indexOf('-X');
    const url = args[xIdx + 2];
    calls.push({ url, args });
    const result = handler(url);
    if (result instanceof Error) throw result;
    return `${JSON.stringify(result)}\n200`;
  });
  return { fn, calls };
}

test('listCandidatePullRequests() calls Pantheon GitHub facade: repos listing then per-repo pulls', async (t) => {
  const { fn: exec, calls } = makePantheonGhExec(t, (url) => {
    if (url.includes('/api/github/repos?')) return [{ full_name: 'mdostal/auriga' }, { full_name: 'mdostal/heimdall' }];
    if (url.includes('/pulls?')) return [];
    return null;
  });
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL, exec, reviewRepoOwner: 'mdostal', reviewSearchRepos: ['mdostal/pantheon-v2'] });

  backlog.listCandidatePullRequests();

  const repoCalls = calls.filter((c) => c.url.includes('/api/github/repos?'));
  const prCalls = calls.filter((c) => c.url.includes('/pulls?'));
  assert.equal(repoCalls.length, 1, 'one repo-listing call for reviewRepoOwner');
  assert.ok(repoCalls[0].url.includes('owner=mdostal'), 'repo listing must use ?owner= (not ?org=) to match Pantheon facade query param');
  assert.ok(prCalls.length >= 2, 'at least one pulls call per repo (auriga + heimdall from listing, plus pantheon-v2 from reviewSearchRepos)');
});

test('listCandidatePullRequests() unions Pantheon repo listing with reviewSearchRepos, dedupes, tags each PR with _repo', async (t) => {
  const { fn: exec } = makePantheonGhExec(t, (url) => {
    if (url.includes('/api/github/repos?')) return [{ full_name: 'mdostal/auriga' }, { full_name: 'mdostal/heimdall' }];
    if (url.includes('/mdostal/auriga/pulls')) return [{ number: 1, title: 'a PR', head: { ref: 'feat/pant-1' }, state: 'open' }];
    if (url.includes('/mdostal/heimdall/pulls')) return [{ number: 2, title: 'h PR', head: { ref: 'feat/h-1' }, state: 'open' }];
    if (url.includes('/mdostal/consus/pulls')) return [{ number: 3, title: 'c PR', head: { ref: 'feat/c-1' }, state: 'open' }];
    return [];
  });
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({
    baseUrl: BASE_URL, exec, reviewRepoOwner: 'mdostal', reviewSearchRepos: ['mdostal/auriga', 'mdostal/consus'],
  });

  const prs = backlog.listCandidatePullRequests();

  // mdostal/auriga is in both ghListRepos result AND reviewSearchRepos — deduped to one scan.
  const sorted = prs.slice().sort((a, b) => a.number - b.number);
  assert.equal(sorted.length, 3);
  assert.equal(sorted[0].number, 1); assert.equal(sorted[0]._repo, 'mdostal/auriga');
  assert.equal(sorted[1].number, 2); assert.equal(sorted[1]._repo, 'mdostal/heimdall');
  assert.equal(sorted[2].number, 3); assert.equal(sorted[2]._repo, 'mdostal/consus');
  // head_ref is flattened from head.ref by pantheon-github.mjs
  assert.equal(sorted[0].head_ref, 'feat/pant-1');
});

test('listCandidatePullRequests() isolates a single repo\'s failure -- other repos still scanned, never throws', async (t) => {
  const { fn: exec } = makePantheonGhExec(t, (url) => {
    if (url.includes('/api/github/repos?')) throw new Error('Pantheon: 503 GITHUB_TOKEN absent');
    if (url.includes('/mdostal/auriga/pulls')) throw new Error('Pantheon: 404 Not Found');
    if (url.includes('/mdostal/consus/pulls')) return [{ number: 9, title: 'ok', head: { ref: 'feat/ok' }, state: 'open' }];
    return [];
  });
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({
    baseUrl: BASE_URL, exec, reviewRepoOwner: 'mdostal', reviewSearchRepos: ['mdostal/auriga', 'mdostal/consus'],
  });

  const prs = backlog.listCandidatePullRequests();

  // repo-listing failed (falls back to just reviewSearchRepos), auriga's own PR list
  // failed too, but consus's succeeded -- one real PR survives, nothing throws.
  assert.equal(prs.length, 1);
  assert.equal(prs[0].number, 9);
  assert.equal(prs[0]._repo, 'mdostal/consus');
});

test('setIssueStatus() POSTs {status} and PROPAGATES a failure (write methods never degrade)', async (t) => {
  makeCurlMock(t, () => new Error('HTTP 502'));
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

// ---- createIssue() (t015 -- orchestrator hand-up) --------------------------------------

test('createIssue() POSTs to /api/backlog/issues with the confirmed real body shape and PROPAGATES a failure', async (t) => {
  makeCurlMock(t, () => new Error('HTTP 502'));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  assert.throws(() => backlog.createIssue({ title: 'Handed up' }), /HTTP 502/);
});

test('createIssue() success path sends title/description/status/labels/metadata/parent/project and maps the response through toRawIssue()', async (t) => {
  const calls = makeCurlMock(t, () => ({
    status: 201,
    body: rawBoardIssue({ identifier: 'PAN-99', title: 'Handed up', project: 'parent-project-id' }),
  }));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL });

  const created = backlog.createIssue({
    title: 'Handed up',
    description: 'needs cross-project decision',
    status: 'todo',
    labels: ['hand-up'],
    metadata: { handed_up_from: 'PAN-1' },
    parent: 'PAN-0',
    project: 'parent-project-id',
  });

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${BASE_URL}/api/backlog/issues`);
  assert.deepEqual(calls[0].body, {
    title: 'Handed up',
    description: 'needs cross-project decision',
    status: 'todo',
    labels: ['hand-up'],
    metadata: { handed_up_from: 'PAN-1' },
    parent: 'PAN-0',
    project: 'parent-project-id',
  });
  assert.equal(created.identifier, 'PAN-99');
  assert.equal(created.title, 'Handed up');
});

test('createIssue() falls back to cfg.project as the default target when ticket.project is omitted', async (t) => {
  const calls = makeCurlMock(t, () => ({ status: 201, body: rawBoardIssue({ identifier: 'PAN-100' }) }));
  const { createPantheonV2L2BacklogAdapter } = await freshAdapterModule();
  const backlog = createPantheonV2L2BacklogAdapter({ baseUrl: BASE_URL, project: 'default-project-id' });

  backlog.createIssue({ title: 'Handed up' });

  assert.equal(calls[0].body.project, 'default-project-id');
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
