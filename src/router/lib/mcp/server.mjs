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
// imports a vendor-specific module (e.g. lib/multica.mjs, or Multica CLI
// invocations) from outside backlog-adapter.mjs's own implementations —
// every tool handler below calls only the BacklogAdapter's typed interface
// (see ../adapters/backlog-adapter.mjs and adapter-boundary-integrity in
// .pHive/cross-cutting-concerns.yaml).
//
// MEASURED LATENCY against the real Multica adapter (this story's own
// verification requirement — see the risks section of p5-mcp-server.yaml):
// listAllProjectIds() ~20ms, listAllIssues(projectIds) ~20ms (this
// workspace's board is small — 1 project, 4 issues, so board-wide scans via
// auriga_list_board/auriga_list_blocked_and_inflight are cheap here, though
// that will scale with board size). getIssuePullRequests(identifier) — the
// method auriga_get_story used to call directly — took ~75s: it does an
// UNCACHED live `gh pr list --state all` scan across every configured repo
// (7 repos, 1260 PRs) on EVERY call, no memoization, exactly the cost
// multica/backlog.mjs's own doc comment on that method warns about ("kept
// for a standalone caller with no board-wide cache available").
//
// FIXED (follow-up after this story's own verification flagged it): this
// long-lived stdio server process IS a caller that can have a board-wide
// cache — exactly the gap that method's doc comment names. auriga_get_story
// now reuses the SAME fix auriga-router.mjs's cycle() already proved:
// listCandidatePullRequests() (the raw, unfiltered board-wide scan) is
// called ONCE, cached with a short TTL, and filtered per-story client-side
// with core.mjs's prMatchesStory — the same broader, slug-aware matcher the
// router uses for display purposes (not the narrower per-identifier
// prMatchesIdentifier heuristic getIssuePullRequests's own gh-fallback used,
// which is documented to silently miss slug-only-branched PRs — see
// backlog.mjs's own comment on that history, PAN-7150). First call after
// server start (or after the cache goes stale) still pays the full scan
// cost; every call within the TTL is effectively instant. Falls back to
// getIssuePullRequests(identifier) per-call when the adapter has no
// listCandidatePullRequests (the stub adapter — cheap in-memory lookup,
// caching would add nothing there) — same presence-check-and-fallback shape
// scanAllIssues below already uses for listAllIssues.
//
// Adapter selection: real Multica-backed adapter by default (matches
// auriga-router.mjs's own default). NOTE ON THE ENV-VAR SWITCH: the story
// spec asserts a "p2-adapter-interface environment-variable switch for
// selecting the stub adapter" already exists for the router and says to
// reuse it verbatim. That assumption does not hold — verified by reading
// auriga-router.mjs, lib/config.mjs, lib/config-substrate.mjs, and every
// p2-adapter-interface story end to end: the router selects the stub ONLY
// via `cycle()`'s test-time options bag (dependency injection in tests),
// never via a runtime env var; no such env var exists anywhere in this
// codebase today (grepped repo-wide). A stdio MCP server is a real OS
// process with no test harness to inject options into, so it needs an
// actual runtime switch. AURIGA_BACKLOG_ADAPTER=stub below is that switch,
// named to match this repo's one existing env-var convention
// (AURIGA_PIDFILE/AURIGA_LOG/AURIGA_PER_CYCLE_TOTAL/.../AURIGA_PHIVE_ROOT)
// rather than inventing a new naming scheme. Flagged explicitly in this
// story's verification writeup rather than silently diverging from the spec.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createMulticaBacklogAdapter } from '../adapters/multica/backlog.mjs';
import { createStubBacklogAdapter } from '../adapters/stub/backlog.mjs';
import { prMatchesStory } from '../core.mjs';
import * as cfg from '../config.mjs';

// TTL for the cached board-wide PR candidate scan (see getStoryPullRequests
// below) — long enough that a burst of auriga_get_story calls in one
// operator session shares one ~75s scan instead of paying it per call, short
// enough that a stale PR list doesn't linger for the server's whole
// lifetime. Not user-configurable — this is an internal perf detail, not a
// contract callers depend on.
const CANDIDATE_PR_CACHE_TTL_MS = 5 * 60 * 1000;

export const SERVER_NAME = 'auriga';
export const SERVER_VERSION = '0.1.0';

// ---- adapter selection ----------------------------------------------------

/**
 * Real Multica-backed adapter by default — matches auriga-router.mjs's own
 * `defaultBacklog` construction (same reviewRepoOwner/reviewSearchRepos
 * wiring, so PR discovery searches the same repo set). Stub via
 * AURIGA_BACKLOG_ADAPTER=stub (see file header note on why this env var,
 * not a pre-existing one, is the actual switch) — zero live external
 * systems present, same standalone guarantee the router's own stub path
 * gives.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('../adapters/backlog-adapter.mjs').BacklogAdapter}
 */
export function selectBacklogAdapter(env = process.env) {
  if (env.AURIGA_BACKLOG_ADAPTER === 'stub') {
    return createStubBacklogAdapter();
  }
  return createMulticaBacklogAdapter({
    reviewRepoOwner: cfg.REVIEW_REPO_OWNER,
    reviewSearchRepos: cfg.REVIEW_SEARCH_REPOS,
  });
}

// ---- shared read helpers ---------------------------------------------------

// Board-wide issue scan. Prefers backlog.listAllIssues (a documented
// "ported adapter extra", NOT part of the BacklogAdapter typedef contract —
// see multica/backlog.mjs's own header comment) when the adapter exposes
// it, falling back to a per-project listIssues loop when it doesn't (the
// stub adapter has no listAllIssues). This is the SAME presence-check-and-
// fallback shape auriga-router.mjs's cycle() already uses for
// listCandidatePullRequests vs getIssuePullRequests — mirrored here
// deliberately rather than inventing a different convention.
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

// PRs for one story. Prefers a cached, TTL-bounded board-wide scan
// (backlog.listCandidatePullRequests, when the adapter exposes it) filtered
// client-side with the broader prMatchesStory matcher — see the file header
// note on why this replaced a direct per-call getIssuePullRequests(identifier).
// `cache` is an explicit, injectable {prs, fetchedAt} holder (not module-level
// global state) so tests can control/observe it and multiple server instances
// never share state — createAurigaMcpServer below creates one per server
// instance and threads it through every auriga_get_story call.
function getStoryPullRequests(backlog, issue, cache) {
  if (typeof backlog.listCandidatePullRequests !== 'function') {
    return backlog.getIssuePullRequests(issue.identifier);
  }
  const now = Date.now();
  if (!cache.prs || now - cache.fetchedAt > CANDIDATE_PR_CACHE_TTL_MS) {
    cache.prs = backlog.listCandidatePullRequests();
    cache.fetchedAt = now;
  }
  return cache.prs.filter((pr) => prMatchesStory(pr, issue));
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
 * @param {import('../adapters/backlog-adapter.mjs').BacklogAdapter} backlog
 * @param {{ identifier: string, project_id?: string }} args
 * @param {{ prs: object[]|null, fetchedAt: number }} [prCache] — see
 *   getStoryPullRequests above. Defaults to a fresh, unshared cache so
 *   direct calls (e.g. in tests) behave exactly as before — no cross-call
 *   reuse unless a caller explicitly threads one through (which
 *   createAurigaMcpServer does, once per server instance).
 */
export function getStory(backlog, args, prCache = { prs: null, fetchedAt: 0 }) {
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
    pull_requests: getStoryPullRequests(backlog, issue, prCache),
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
  const blocked = issues.filter((i) => i.status === 'blocked').map((i) => shapeIssue(i, issues));
  const inFlight = issues
    .filter((i) => i.status === 'in_progress' || i.status === 'in_review')
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
  // One shared, TTL-bounded PR-candidate cache per server instance — see
  // getStoryPullRequests. Every auriga_get_story call threads through this
  // same object, so a burst of calls in one operator session pays the
  // expensive board-wide scan at most once per TTL window, not once per call.
  const prCandidateCache = { prs: null, fetchedAt: 0 };

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
        'project_id if known to avoid a board-wide search. READ-ONLY. NOTE: the ' +
        'pull-request lookup is a cached, board-wide scan (5-minute TTL) — the ' +
        'FIRST call after server start (or after the cache goes stale) does a live ' +
        'GitHub scan across every configured repo and was measured at ~75s against ' +
        'this workspace\'s real board; every call within the TTL window after that ' +
        'reuses the cached result and is fast.',
      inputSchema: {
        identifier: z.string().describe('The issue\'s public identifier, e.g. "PAN-1234".'),
        project_id: z.string().optional().describe('Narrow the search to one project.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => toolResult(getStory(backlog, args, prCandidateCache)),
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
