// BacklogAdapter — the read/write contract for whatever system tracks and
// stores work items (issues/stories/tickets). This file defines ONLY the
// shape, via a JSDoc @typedef; it has no runtime code and is never imported
// for its exports. Concrete implementations are plain factory-function
// modules (createXBacklogAdapter(cfg)) returning a frozen object literal —
// never an ES6 class (this codebase has zero `class` declarations anywhere).
// See stub/backlog.mjs for the reference in-memory implementation.
//
// This is one half of Auriga's two-adapter model — see ./README.md for the
// full rationale and the no-pre-emptive-integrations rule that governs both
// adapters. It must stay backlog-system-agnostic: no method here may name or
// assume a specific vendor (Multica, GitHub, Linear, Jira, ...) or a
// vendor-specific field shape.
//
// Every method is async (returns a Promise) — that is the CONTRACT this
// story defines. Note that auriga-router.mjs's cycle() (the pre-existing,
// unmodified consumer) currently calls its injected `mca` dependency
// SYNCHRONOUSLY (never `await`s it) — see that file's own doc comment on
// cycle(). Bridging an async BacklogAdapter into that synchronous call site
// is a caller-side concern (see test/standalone-smoke.test.mjs for the
// pattern), not something this contract compromises on: the async shape is
// what a real network-backed implementation (Multica or otherwise) will
// actually need, and what a future cutover of cycle() itself is expected to
// await directly.
//
// "id" / "identifier" below always means the issue's human-readable public
// identifier (e.g. "PAN-1234"), matching the convention every existing
// mca-shaped call site already uses (see test/support/mock-mca.mjs) — never
// an internal/opaque database id.

/**
 * @typedef {Object} BacklogAdapter
 *
 * @property {(projectId: string) => Promise<object[]>} listIssues
 *   All issues (whatever the backlog calls a work item) in one project.
 *
 * @property {() => Promise<string[]>} listAllProjectIds
 *   Every project id the backlog knows about — used for the board-wide scan
 *   the STATUS passes need (unblock, parent-rollup, false-done,
 *   run-completion, verified-done all look board-wide, not just at the
 *   dispatch-aligned project set).
 *
 * @property {(id: string) => Promise<object[]>} getIssueRuns
 *   The dispatch/execution history for one issue (agent runs, builds,
 *   whatever the runner calls an attempt) — used to classify
 *   active/done/failed/stale (see lib/core.mjs's classifyRun).
 *
 * @property {(id: string) => Promise<object[]>} getIssuePullRequests
 *   Pull/merge requests linked to one issue — used to verify a run's success
 *   claim against a REAL merge (see lib/core.mjs's detectVerifiedDone);
 *   run status alone is never trusted as "done".
 *
 * @property {(id: string, status: string) => Promise<void>} setIssueStatus
 *   Move an issue to a new status (todo/in_progress/in_review/done/blocked/
 *   cancelled/...).
 *
 * @property {(id: string, body: string) => Promise<void>} commentOnIssue
 *   Post a comment onto an issue (e.g. the review-squad plan — see
 *   lib/core.mjs's squadPlanSummary).
 */

export {};
