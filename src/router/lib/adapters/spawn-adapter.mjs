// SpawnAdapter — the contract for whatever system actually runs an agent
// against an issue (assign it, kick off a run, tear it down). This file
// defines ONLY the shape, via a JSDoc @typedef; it has no runtime code and is
// never imported for its exports. Concrete implementations are plain
// factory-function modules (createXSpawnAdapter(cfg)) returning a frozen
// object literal — never an ES6 class. See stub/spawn.mjs for the reference
// in-memory implementation.
//
// This is the other half of Auriga's two-adapter model — see ./README.md.
//
// Every method is SYNCHRONOUS (returns its plain result directly, never a
// Promise) — see backlog-adapter.mjs's doc comment for why that is the right
// contract: it matches the pre-existing, unmodified auriga-router.mjs's
// cycle(), which calls its injected `mca` dependency synchronously today.
//
// "id" below always means the issue's human-readable public identifier
// (e.g. "PAN-1234"), matching every existing mca-shaped call site.
//
// *****************************************************************
// *** SpawnAdapter has NO provisioning method, hook, or middleware
// *** slot of ANY kind — by design, not by omission.
// ***
// *** Auriga's core must never pre-build a concept for a tool
// *** (Vulcan, or any future provisioner) it doesn't yet have a real
// *** story that needs. Do NOT add a `provision(...)` /
// *** `createEnvironment(...)` / `bootstrap(...)` method (or any
// *** hook/middleware slot that amounts to the same thing) to this
// *** typedef, ever, without a real story that needs it AND an
// *** explicit design decision revisiting this rule.
// ***
// *** See .pHive/CONTEXT.md, the adapter-boundary-integrity
// *** cross-cutting concern, and ./README.md's "no pre-emptive
// *** integrations" rule for the full rationale.
// *****************************************************************

/**
 * @typedef {Object} SpawnAdapter
 *
 * @property {(issue: object, lane: string) => object} dispatch
 *   Start a fresh run of `issue` on `lane` (a dispatch-target name from
 *   describeLanes()) — the general-purpose "make this run" primitive.
 *
 * @property {() => Record<string, object>} describeLanes
 *   The available dispatch targets: lane name -> lane metadata (which
 *   agents/runtimes it maps to, capacity, etc.) — the runner-side analog of
 *   lib/config.mjs's PROJECT_LANE / HIVE_LANE / DEFAULT_LANE tables.
 *
 * @property {(id: string, agent: string) => void} assignIssue
 *   Assign an issue to a named agent, WITHOUT necessarily enqueuing a run —
 *   matches the existing assign-then-verify-then-rerun dance in
 *   auriga-router.mjs's cycle(), which treats assignment and run-enqueue as
 *   separate steps (the "dispatch dead-zone" cycle()'s own comments describe).
 *
 * @property {(id: string) => void} rerunIssue
 *   Force-enqueue a run for an issue's CURRENT assignment.
 *
 * @property {(id: string) => void} unassignIssue
 *   Clear an issue's assignee (e.g. so a freshly-unblocked story re-enters
 *   the candidate pool as unassigned — see lib/core.mjs's detectUnblocks).
 */

export {};
