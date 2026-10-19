// PANT-818: proves the operator-facing surfaces reach the board ONLY through
// Pantheon core-api. Mirrors no-github-calls.test.mjs, one level lower:
// node:child_process is module-mocked so every process the default
// (pantheon-v2-l2) adapter spawns is recorded. `curl` calls are answered by a
// fake core-api; any `multica` or `gh` invocation, or any /api/github URL,
// is a violation. Every MCP tool is driven over the real MCP protocol, and
// the Config-Expose API's /api/lanes and /api/gaps are hit through
// createApp() with the same default adapter.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// BoardQueue-shaped (camelCase) issues, as core-api's /api/backlog returns them.
const CORE_API_ISSUES = [
  { id: 'id-epic', identifier: 'PANT-1', title: 'Epic', status: 'in_progress', project: 'proj-a', parentId: null, labels: [], metadata: {} },
  { id: 'id-story', identifier: 'PANT-2', title: 'Story', status: 'in_review', project: 'proj-a', parentId: 'id-epic', labels: [], metadata: { target_repo: 'mdostal/auriga' } },
  { id: 'id-blocked', identifier: 'PANT-3', title: 'Blocked', status: 'blocked', project: 'proj-b', parentId: null, labels: [], metadata: {} },
];
const LINKED_PRS = { 'PANT-2': [{ url: 'https://github.com/mdostal/auriga/pull/9', state: 'open' }] };

function fakeCoreApi(method, url) {
  const { pathname, searchParams } = new URL(url);
  if (method !== 'GET') return { status: 405, body: {} };
  if (pathname === '/api/backlog/issues') {
    const project = searchParams.get('project');
    return { status: 200, body: { issues: CORE_API_ISSUES.filter((i) => !project || i.project === project) } };
  }
  let m = pathname.match(/^\/api\/backlog\/issues\/([^/]+)\/runs$/);
  if (m) return { status: 200, body: { runs: [] } };
  m = pathname.match(/^\/api\/backlog\/issues\/([^/]+)\/pull-requests$/);
  if (m) return { status: 200, body: { pull_requests: LINKED_PRS[decodeURIComponent(m[1])] || [] } };
  return { status: 404, body: { error: `fake core-api: no route ${pathname}` } };
}

// Installed ONCE, before any dynamic import: the ESM cache keeps the first
// binding of node:child_process each adapter module sees, so a per-test mock
// would only reach the first test. Tests reset `calls` instead.
const calls = { curl: [], violations: [] };
mock.module('node:child_process', {
  namedExports: {
    execFileSync(cmd, args) {
      if (cmd !== 'curl') {
        calls.violations.push(`${cmd} ${(args || []).join(' ')}`);
        throw new Error(`direct ${cmd} invocation is forbidden`);
      }
      const method = args[args.indexOf('-X') + 1];
      const url = args.find((a) => /^https?:\/\//.test(a));
      calls.curl.push(`${method} ${url}`);
      if (url.includes('/api/github')) calls.violations.push(`curl ${url}`);
      const res = fakeCoreApi(method, url);
      return `${JSON.stringify(res.body)}\n${res.status}`;
    },
    execFile() { calls.violations.push('execFile'); },
    spawn() { calls.violations.push('spawn'); },
  },
});

function resetCalls() {
  calls.curl.length = 0;
  calls.violations.length = 0;
}

test('every MCP tool, on the default adapter, talks only to core-api: zero multica/gh/github calls', async () => {
  resetCalls();
  const { createAurigaMcpServer, selectBacklogAdapter } = await import('../lib/mcp/server.mjs');

  const backlog = selectBacklogAdapter({ PANTHEON_API_URL: 'http://core-api.test:3012' });
  const server = createAurigaMcpServer(backlog);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const { tools } = await client.listTools();
  const invocations = [
    ['auriga_list_board', {}],
    ['auriga_list_board', { project_id: 'proj-a', status: 'in_review' }],
    ['auriga_get_story', { identifier: 'PANT-2' }],
    ['auriga_get_story', { identifier: 'PANT-2', project_id: 'proj-a' }],
    ['auriga_get_story', { identifier: 'NOPE-1' }],
    ['auriga_list_blocked_and_inflight', {}],
    ['auriga_list_blocked_and_inflight', { project_id: 'proj-b' }],
  ];
  // Guard: this test must cover every registered tool, including any added later.
  assert.deepEqual([...new Set(invocations.map(([name]) => name))].sort(), tools.map((tool) => tool.name).sort());

  const results = {};
  for (const [name, args] of invocations) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, undefined, `${name} errored: ${res.content?.[0]?.text}`);
    results[`${name} ${JSON.stringify(args)}`] = JSON.parse(res.content[0].text);
  }

  // Real data flowed through core-api, including the board-linked PRs.
  assert.equal(results['auriga_list_board {}'].count, 3);
  const story = results['auriga_get_story {"identifier":"PANT-2"}'];
  assert.equal(story.found, true);
  assert.deepEqual(story.pull_requests, LINKED_PRS['PANT-2']);
  assert.equal(results['auriga_list_blocked_and_inflight {}'].blocked_count, 1);
  assert.ok(calls.curl.some((c) => c === 'GET http://core-api.test:3012/api/backlog/issues/PANT-2/pull-requests'));

  assert.ok(calls.curl.length > 0, 'expected core-api calls');
  assert.ok(calls.curl.every((c) => c.includes('http://core-api.test:3012/api/backlog/')), calls.curl.join('\n'));
  assert.deepEqual(calls.violations, []);
});

test('Config-Expose API /api/lanes and /api/gaps, on the default adapter, talk only to core-api', async (t) => {
  resetCalls();
  const { createApp } = await import('../../server.mjs');

  const server = createApp({ env: { PANTHEON_API_URL: 'http://core-api.test:3012' } }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const lanes = await fetch(`${base}/api/lanes`);
  assert.equal(lanes.status, 200);
  const gaps = await fetch(`${base}/api/gaps`);
  assert.equal(gaps.status, 200);
  const body = await gaps.json();
  // core-api has no project-list/autopilot endpoint: named, never faked as [].
  assert.equal(body.missing_projects, null);
  assert.equal(body.autopilot_scheduler_gaps, null);
  assert.deepEqual(Object.keys(body.unavailable).sort(), ['autopilot_scheduler_gaps', 'missing_projects']);

  assert.ok(calls.curl.length > 0, 'expected core-api calls');
  assert.ok(calls.curl.every((c) => c.includes('http://core-api.test:3012/api/backlog/')), calls.curl.join('\n'));
  assert.deepEqual(calls.violations, []);
});
