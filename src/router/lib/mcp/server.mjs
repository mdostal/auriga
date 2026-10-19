// Auriga's MCP server — a third gatekeeper surface alongside
// auriga-router.mjs (the decide+assign daemon) and src/server/ (the
// read-only HTTP API over local .pHive/ planning docs). This module lets an
// operator's own Claude Code / Codex CLI session query Auriga's LIVE board
// state directly as tool calls, without opening the dashboard.
//
// READ-ONLY, FULL STOP. See the story spec
// (.pHive/epics/p5-agent-mcp-integration/stories/p5-mcp-server.yaml) and
// design-discussion.md's Open Question 1 (resolved, operator sign-off): this
// was an explicit, deliberated decision after a security review found that
// exposing ANY mutate capability to an LLM tool call — even from an
// unattended session — is an unresolved safety risk. backlogAdapter's
// setIssueStatus/commentOnIssue methods already exist and would be trivial
// to wrap here — they are DELIBERATELY NOT exposed, anywhere in this file.
// Do not add a write tool to this module without a new story that
// explicitly re-litigates that risk; "v1 shipped read-only and nothing bad
// happened" is not itself a resolution of it (design-discussion.md's own
// risk note).
//
// Calls backlogAdapter directly, in-process — mirrors Portunus's own MCP
// server design decision (mcp_server.py: "this module calls the Portunus
// library directly ... no subprocess boundary needed"), not a subprocess or
// HTTP boundary. NEVER imports src/server/ (a separate, hardcoded-read-only
// HTTP layer over local .pHive/*.yaml planning docs, not live board state —
// confirmed unusable for this purpose in research-brief.md §2) and NEVER
// imports a vendor-specific module (the Multica CLI wrapper, or any direct
// Multica/GitHub call) — every tool handler below calls only the BacklogAdapter's typed interface
// (see ../adapters/backlog-adapter.mjs and adapter-boundary-integrity in
// .pHive/cross-cutting-concerns.yaml).
//
// PULL REQUESTS (PANT-818): auriga_get_story's PR data comes ONLY from the
// board's own linked PRs through Pantheon core-api --
// backlog.getIssuePullRequests(identifier) ->
// GET /api/backlog/issues/:id/pull-requests. It never runs a GitHub search.
// This replaces the earlier cached board-wide `gh pr list` scan
// (listCandidatePullRequests + prMatchesStory, ~75s on a cold cache) that the
// direct-Multica adapter needed; the pantheon-v2-l2 adapter has no such scan
// (removed in PANT-717, see test/no-github-calls.test.mjs).
//
// Adapter selection (PANT-818, ../adapters/select-backlog.mjs): Pantheon's
// pantheon-v2-l2 backlog adapter by default -- the same adapter auriga-router.mjs builds as its defaultBacklog.
// Architecture rule: gods talk only through Pantheon, so this module never
// imports the Multica CLI wrapper or the direct-Multica adapter, and there is
// no direct-Multica mode at all. AURIGA_BACKLOG_ADAPTER is the runtime switch
// (a stdio MCP server is a real OS process with no test harness to inject an
// adapter into): unset or `pantheon-v2-l2` selects core-api, `stub` selects
// the in-memory stub (zero live external systems), and any other value is
// rejected loudly rather than silently falling back to something else.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { selectBacklogAdapter } from '../adapters/select-backlog.mjs';
import { ISSUE_STATUS } from '../issue-status.mjs';

export const SERVER_NAME = 'auriga';
export const SERVER_VERSION = '0.1.0';

// ---- adapter selection ----------------------------------------------------

// selectBacklogAdapter lives in ../adapters/select-backlog.mjs so the
// Config-Expose API (src/server.mjs) shares it without loading the MCP SDK;
// re-exported here because bin/auriga.mjs and the tests import it from this
// module.
export { selectBacklogAdapter };

// ---- shared read helpers ---------------------------------------------------

// Board-wide issue scan. Prefers backlog.listAllIssues (a "ported adapter
// extra", NOT part of the BacklogAdapter typedef contract; pantheon-v2-l2
// implements it as one GET /api/backlog/issues) when the adapter exposes it,
// falling back to a per-project listIssues loop when it doesn't (the stub
// adapter has no listAllIssues).
function scanAllIssues(backlog) {
  const projectIds = backlog.listAllProjectIds();
  if (typeof backlog.listAllIssues === 'function') {
    return { projectIds, issues: backlog.listAllIssues(projectIds) };
  }
  const issues = [];
  for (const projectId of projectIds) {
    for (const issue of backlog.listIssues(projectId)) issues.push(issue);
  }
  return { projectIds, issues };
}

// Trim + shape one issue for tool output. "role" is computed relative to
// `siblingIssues` (an issue is an 'epic' iff some OTHER issue in that same
// working set names it via parent_issue_id — mirrors lib/core.mjs's own
// parent-detection in detectParentRollups, not a new definition of "epic").
// When siblingIssues is scoped to one project, this is still accurate in
// practice — an epic's stories all land in the same project (see
// multica/backlog.mjs's own comment making the same observation for
// dependency resolution).
function shapeIssue(issue, siblingIssues) {
  const isParent = siblingIssues.some((i) => i.parent_issue_id === issue.id);
  return {
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    role: isParent ? 'epic' : 'story',
    project_id: issue.project_id,
    parent_issue_id: issue.parent_issue_id || null,
    assignee_id: issue.assignee_id || null,
  };
}

function findByIdentifier(issues, identifier) {
  return issues.find((i) => i.identifier === identifier);
}

// ---- tool handlers (plain functions, independently unit-testable) --------

/**
 * List epics/stories with status — board-wide, or scoped to one project.
 * @param {import('../adapters/backlog-adapter.mjs').BacklogAdapter} backlog
 * @param {{ project_id?: string, status?: string }} [args]
 */
export function listBoard(backlog, args = {}) {
  const { project_id, status } = args;
  const issues = project_id ? backlog.listIssues(project_id) : scanAllIssues(backlog).issues;
  const shaped = issues
    .map((i) => shapeIssue(i, issues))
    .filter((i) => !status || i.status === status);
  return {
    project_id: project_id || null,
    status_filter: status || null,
    count: shaped.length,
    issues: shaped,
  };
}

/**
 * Get full detail for one story/epic by identifier: the issue itself, its
 * dispatch/run history, and any linked pull requests.
 * pull_requests are the board's own linked PRs via
 * backlog.getIssuePullRequests (core-api), never a GitHub search.
 * @param {import('../adapters/backlog-adapter.mjs').BacklogAdapter} backlog
 * @param {{ identifier: string, project_id?: string }} args
 */
export function getStory(backlog, args) {
  const { identifier, project_id } = args;
  const issues = project_id ? backlog.listIssues(project_id) : scanAllIssues(backlog).issues;
  const issue = findByIdentifier(issues, identifier);
  if (!issue) {
    return {
      found: false,
      identifier,
      message: project_id
        ? `no issue with identifier "${identifier}" found in project "${project_id}"`
        : `no issue with identifier "${identifier}" found on the board`,
    };
  }
  return {
    found: true,
    issue: {
      ...shapeIssue(issue, issues),
      description: issue.description || '',
      labels: issue.labels || [],
      metadata: issue.metadata || {},
    },
    runs: backlog.getIssueRuns(identifier),
    pull_requests: backlog.getIssuePullRequests(issue.identifier),
  };
}

/**
 * What's blocked / what's in-flight, board-wide or scoped to one project.
 * "in-flight" = in_progress or in_review (dispatched but not yet merged);
 * "blocked" = status === 'blocked' (a declared dependency isn't satisfied
 * yet — see multica/backlog.mjs's status-enum note distinguishing this from
 * a merely-unpicked 'todo').
 * @param {import('../adapters/backlog-adapter.mjs').BacklogAdapter} backlog
 * @param {{ project_id?: string }} [args]
 */
export function listBlockedAndInflight(backlog, args = {}) {
  const { project_id } = args;
  const issues = project_id ? backlog.listIssues(project_id) : scanAllIssues(backlog).issues;
  const blocked = issues.filter((i) => i.status === ISSUE_STATUS.BLOCKED).map((i) => shapeIssue(i, issues));
  const inFlight = issues
    .filter((i) => i.status === ISSUE_STATUS.IN_PROGRESS || i.status === ISSUE_STATUS.IN_REVIEW)
    .map((i) => shapeIssue(i, issues));
  return {
    project_id: project_id || null,
    blocked_count: blocked.length,
    in_flight_count: inFlight.length,
    blocked,
    in_flight: inFlight,
  };
}

// ---- MCP wiring ------------------------------------------------------------

function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// Every tool below is annotated readOnlyHint:true/destructiveHint:false —
// an explicit, machine-readable assertion of this file's hard read-only
// constraint, on top of the fact that no write-capable tool is registered
// anywhere in this function. There are exactly THREE tools, matching the
// story's acceptance criteria verbatim ("list epics/stories with status,
// get story detail, check what's blocked/in-flight") — resist adding a
// fourth "for convenience" (e.g. a raw listAllProjectIds passthrough); see
// lib/adapters/README.md's "no pre-emptive integrations" rule, which this
// generalizes to tool surfaces too.
//
// @param {import('../adapters/backlog-adapter.mjs').BacklogAdapter} backlog
export function createAurigaMcpServer(backlog) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'auriga_list_board',
    {
      title: 'List Auriga board (epics/stories with status)',
      description:
        'List issues (epics and stories) on Auriga\'s board with their status. ' +
        'Omit project_id for a board-wide scan across every known project; pass ' +
        'it to scope the listing to one project (cheaper — one call instead of a ' +
        'board-wide scan). Optionally filter by exact status (e.g. "todo", ' +
        '"in_progress", "in_review", "blocked", "done"). READ-ONLY.',
      inputSchema: {
        project_id: z.string().optional().describe('Scope the listing to one project id.'),
        status: z.string().optional().describe('Filter to issues with this exact status.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => toolResult(listBoard(backlog, args)),
  );

  server.registerTool(
    'auriga_get_story',
    {
      title: 'Get story/epic detail',
      description:
        'Get full detail for one issue by its identifier (e.g. "PAN-1234"): status, ' +
        'hierarchy, dispatch/run history, and any linked pull requests. Pass ' +
        'project_id if known to avoid a board-wide search. READ-ONLY. Pull requests ' +
        'are the ones linked to the issue on the board, read through Pantheon.',
      inputSchema: {
        identifier: z.string().describe('The issue\'s public identifier, e.g. "PAN-1234".'),
        project_id: z.string().optional().describe('Narrow the search to one project.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => toolResult(getStory(backlog, args)),
  );

  server.registerTool(
    'auriga_list_blocked_and_inflight',
    {
      title: "What's blocked / in-flight",
      description:
        'List issues that are currently blocked (a declared dependency is not yet ' +
        'satisfied) and issues that are in-flight (in_progress or in_review — ' +
        'dispatched but not yet merged). Omit project_id for a board-wide scan. ' +
        'READ-ONLY.',
      inputSchema: {
        project_id: z.string().optional().describe('Scope the scan to one project id.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => toolResult(listBlockedAndInflight(backlog, args)),
  );

  return server;
}

/**
 * Start the Auriga MCP server over stdio. This is the function the CLI's
 * `mcp` subcommand (p5-agent-cli, a later story) calls to actually start
 * the server — the CLI module does not duplicate any server logic, it just
 * invokes this.
 * @param {{ backlog?: import('../adapters/backlog-adapter.mjs').BacklogAdapter, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<McpServer>}
 */
export async function startMcpServer(opts = {}) {
  const backlog = opts.backlog || selectBacklogAdapter(opts.env || process.env);
  const server = createAurigaMcpServer(backlog);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC wire — never console.log here (or anywhere in
  // this module/its call graph). stderr is safe for a human-watched
  // liveness note.
  process.stderr.write(`${SERVER_NAME} MCP server (v${SERVER_VERSION}) listening on stdio\n`);
  return server;
}
