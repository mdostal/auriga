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
// Every method is SYNCHRONOUS (returns its plain result directly, never a
// Promise) — that is the CONTRACT this story defines. auriga-router.mjs's
// cycle() (the pre-existing, unmodified consumer) calls its injected `mca`
// dependency synchronously and never `await`s it, because today's real
// implementation (lib/multica.mjs, backed by execFileSync) is genuinely
// synchronous — see that file's own doc comment on cycle(). Matching that
// call convention here means a future cutover of cycle() onto this adapter
// is a mechanical rename, not a control-flow refactor. See ./README.md for
// the fuller rationale.
//
// "id" / "identifier" below always means the issue's human-readable public
// identifier (e.g. "PAN-1234"), matching the convention every existing
// mca-shaped call site already uses (see test/support/mock-mca.mjs) — never
// an internal/opaque database id.

/**
 * @typedef {Object} BacklogAdapter
 *
 * @property {(projectId: string) => object[]} listIssues
 *   All issues (whatever the backlog calls a work item) in one project.
 *
 * @property {() => string[]} listAllProjectIds
 *   Every project id the backlog knows about — used for the board-wide scan
 *   the STATUS passes need (unblock, parent-rollup, false-done,
 *   run-completion, verified-done all look board-wide, not just at the
 *   dispatch-aligned project set).
 *
 * @property {(id: string) => object[]} getIssueRuns
 *   The dispatch/execution history for one issue (agent runs, builds,
 *   whatever the runner calls an attempt) — used to classify
 *   active/done/failed/stale (see lib/core.mjs's classifyRun).
 *
 * @property {(id: string) => object[]} getIssuePullRequests
 *   Pull/merge requests linked to one issue — used to verify a run's success
 *   claim against a REAL merge (see lib/core.mjs's detectVerifiedDone);
 *   run status alone is never trusted as "done".
 *
 * @property {(id: string, status: string) => void} setIssueStatus
 *   Move an issue to a new status (todo/in_progress/in_review/done/blocked/
 *   cancelled/...).
 *
 * @property {(id: string, body: string) => void} commentOnIssue
 *   Post a comment onto an issue (e.g. the review-squad plan — see
 *   lib/core.mjs's squadPlanSummary).
 */

export {};
