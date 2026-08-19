// Unit + protocol-level tests for lib/mcp/server.mjs, against the stub
// backlog adapter only — zero live external systems, matching this
// codebase's existing standalone-guarantee testing convention (see
// standalone-smoke.test.mjs). Two layers:
//   1. Handler-level tests call listBoard/getStory/listBlockedAndInflight
//      directly against createStubBacklogAdapter(seedData) — fast, and
//      exercises the actual read logic without any MCP protocol machinery.
//   2. A real MCP protocol round-trip (InMemoryTransport + Client) proves
//      AC1 for real: tools/list reports EXACTLY the three read-only tools
//      and nothing else — not a claim about the handler functions, a claim
//      about what the wire protocol actually advertises to a connected
//      client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStubBacklogAdapter } from '../lib/adapters/stub/backlog.mjs';
import {
  createAurigaMcpServer,
  selectBacklogAdapter,
  listBoard,
  getStory,
  listBlockedAndInflight,
} from '../lib/mcp/server.mjs';
import {
  ALL_PROFILES,
  PROFILE_TODO,
  PROFILE_IN_PROGRESS_DONE_RUN,
  PROFILE_IN_REVIEW_MERGED_PR,
  PROFILE_DONE_DEPENDENCY,
  PROFILE_BLOCKED_CLEARED,
  RUNS_BY_IDENTIFIER,
  PULL_REQUESTS_BY_IDENTIFIER,
} from './fixtures/test-profiles-runners.mjs';

function freshBacklog() {
  // Shallow-clone every fixture issue before seeding — the stub adapter
  // mutates in place and these fixtures are shared module-level exports
  // (see standalone-smoke.test.mjs's identical note).
  return createStubBacklogAdapter({
    issues: ALL_PROFILES.map((issue) => ({ ...issue })),
    runsByIdentifier: RUNS_BY_IDENTIFIER,
    pullRequestsByIdentifier: PULL_REQUESTS_BY_IDENTIFIER,
  });
}

// ---- adapter selection ----------------------------------------------------

test('selectBacklogAdapter(): AURIGA_BACKLOG_ADAPTER=stub selects the stub adapter', () => {
  const backlog = selectBacklogAdapter({ AURIGA_BACKLOG_ADAPTER: 'stub' });
  // The stub's tell: listIssues/listAllProjectIds return empty/[] with zero
  // seed data and never shell out (no `.calls`/CLI side effects possible).
  assert.deepEqual(backlog.listAllProjectIds(), []);
  assert.deepEqual(backlog.listIssues('any-project'), []);
});

test('selectBacklogAdapter(): default (no env var) selects the real Multica-backed adapter', () => {
  const backlog = selectBacklogAdapter({});
  // Distinguishing tell: only the real adapter carries the "ported extras"
  // (listAllIssues/listCandidatePullRequests) documented in
  // multica/backlog.mjs — the stub deliberately does not implement them.
  assert.equal(typeof backlog.listAllIssues, 'function');
  assert.equal(typeof backlog.listCandidatePullRequests, 'function');
});

// ---- listBoard --------------------------------------------------------

test('listBoard(): board-wide (no project_id) returns every issue with role/status, epic detected by children', () => {
  const backlog = freshBacklog();
  const result = listBoard(backlog, {});
  assert.equal(result.project_id, null);
  assert.equal(result.count, ALL_PROFILES.length);
  const byId = Object.fromEntries(result.issues.map((i) => [i.identifier, i]));
  assert.equal(byId[PROFILE_TODO.identifier].status, 'todo');
  assert.equal(byId[PROFILE_TODO.identifier].role, 'story');
  assert.equal(byId[PROFILE_BLOCKED_CLEARED.identifier].status, 'blocked');
});

test('listBoard(): project_id scopes to one project via listIssues, not a board-wide scan', () => {
  const backlog = freshBacklog();
  const projectId = PROFILE_TODO.project_id;
  const result = listBoard(backlog, { project_id: projectId });
  assert.equal(result.project_id, projectId);
  assert.ok(result.issues.every((i) => i.project_id === projectId));
  assert.ok(result.issues.some((i) => i.identifier === PROFILE_TODO.identifier));
});

test('listBoard(): status filter narrows results', () => {
  const backlog = freshBacklog();
  const result = listBoard(backlog, { status: 'blocked' });
  assert.equal(result.status_filter, 'blocked');
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.every((i) => i.status === 'blocked'));
});

test('listBoard(): role is "epic" for an issue another issue names as its parent', () => {
  const backlog = createStubBacklogAdapter({
    issues: [
      { identifier: 'EPIC-1', id: 'id-epic-1', project_id: 'p', status: 'in_progress', parent_issue_id: null },
      { identifier: 'STORY-1', id: 'id-story-1', project_id: 'p', status: 'todo', parent_issue_id: 'id-epic-1' },
    ],
  });
  const result = listBoard(backlog, { project_id: 'p' });
  const byId = Object.fromEntries(result.issues.map((i) => [i.identifier, i]));
  assert.equal(byId['EPIC-1'].role, 'epic');
  assert.equal(byId['STORY-1'].role, 'story');
});

// ---- getStory -----------------------------------------------------------

test('getStory(): found issue returns issue detail + runs + pull_requests', () => {
  const backlog = freshBacklog();
  const result = getStory(backlog, { identifier: PROFILE_IN_REVIEW_MERGED_PR.identifier });
  assert.equal(result.found, true);
  assert.equal(result.issue.identifier, PROFILE_IN_REVIEW_MERGED_PR.identifier);
  assert.equal(result.issue.status, 'in_review');
  assert.equal(result.pull_requests.length, 1);
  assert.equal(result.pull_requests[0].state, 'merged');
});

test('getStory(): unknown identifier returns found:false, not a throw', () => {
  const backlog = freshBacklog();
  const result = getStory(backlog, { identifier: 'NOPE-999' });
  assert.equal(result.found, false);
  assert.equal(result.identifier, 'NOPE-999');
  assert.match(result.message, /no issue/i);
});

test('getStory(): runs surfaced for an in_progress issue with a done run', () => {
  const backlog = freshBacklog();
  const result = getStory(backlog, { identifier: PROFILE_IN_PROGRESS_DONE_RUN.identifier });
  assert.equal(result.found, true);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].status, 'done');
});

// ---- listBlockedAndInflight -----------------------------------------------

test('listBlockedAndInflight(): separates blocked from in-flight (in_progress/in_review)', () => {
  const backlog = freshBacklog();
  const result = listBlockedAndInflight(backlog, {});
  const blockedIds = result.blocked.map((i) => i.identifier);
  const inFlightIds = result.in_flight.map((i) => i.identifier);
  assert.ok(blockedIds.includes(PROFILE_BLOCKED_CLEARED.identifier));
  assert.ok(inFlightIds.includes(PROFILE_IN_PROGRESS_DONE_RUN.identifier));
  assert.ok(inFlightIds.includes(PROFILE_IN_REVIEW_MERGED_PR.identifier));
  // done/todo issues must not appear in either bucket.
  assert.ok(!blockedIds.includes(PROFILE_DONE_DEPENDENCY.identifier));
  assert.ok(!inFlightIds.includes(PROFILE_DONE_DEPENDENCY.identifier));
  assert.ok(!blockedIds.includes(PROFILE_TODO.identifier));
  assert.ok(!inFlightIds.includes(PROFILE_TODO.identifier));
  assert.equal(result.blocked_count, result.blocked.length);
  assert.equal(result.in_flight_count, result.in_flight.length);
});

test('listBlockedAndInflight(): no false positives against an empty board', () => {
  const backlog = createStubBacklogAdapter();
  const result = listBlockedAndInflight(backlog, {});
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.in_flight, []);
});

// ---- real MCP protocol round-trip (InMemoryTransport + Client) -----------

async function connectedClient(backlog) {
  const server = createAurigaMcpServer(backlog);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test('MCP protocol: tools/list reports EXACTLY the three read-only tools and nothing else — no write/mutate tool of any kind', async () => {
  const { client } = await connectedClient(freshBacklog());
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'auriga_get_story',
    'auriga_list_blocked_and_inflight',
    'auriga_list_board',
  ]);
  // Belt-and-suspenders: no tool name or description contains a
  // write/mutate verb (set/create/comment/delete/update/cancel/assign/
  // rerun/unassign) that would signal a mutate capability slipped in.
  const writeVerbs = /\b(set|create|delete|update|cancel|assign|rerun|unassign|comment|mutate|write)\b/i;
  for (const t of tools) {
    assert.equal(writeVerbs.test(t.name), false, `tool name "${t.name}" looks write-capable`);
    assert.equal(t.annotations?.readOnlyHint, true, `tool "${t.name}" must be annotated readOnlyHint:true`);
    assert.equal(t.annotations?.destructiveHint, false, `tool "${t.name}" must be annotated destructiveHint:false`);
  }
});

test('MCP protocol: tools/call auriga_list_board round-trips real stub data over the wire', async () => {
  const { client } = await connectedClient(freshBacklog());
  const result = await client.callTool({ name: 'auriga_list_board', arguments: {} });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.count, ALL_PROFILES.length);
});

test('MCP protocol: tools/call auriga_get_story round-trips found:false for an unknown identifier', async () => {
  const { client } = await connectedClient(freshBacklog());
  const result = await client.callTool({
    name: 'auriga_get_story',
    arguments: { identifier: 'NOPE-999' },
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.found, false);
});

test('MCP protocol: tools/call auriga_list_blocked_and_inflight round-trips real stub data over the wire', async () => {
  const { client } = await connectedClient(freshBacklog());
  const result = await client.callTool({ name: 'auriga_list_blocked_and_inflight', arguments: {} });
  const payload = JSON.parse(result.content[0].text);
  assert.ok(payload.blocked.some((i) => i.identifier === PROFILE_BLOCKED_CLEARED.identifier));
});
