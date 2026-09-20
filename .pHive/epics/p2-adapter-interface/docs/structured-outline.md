# Structured Outline: Adapter-Interface Extraction

**Epic:** p2-adapter-interface
**Inputs:** design-discussion.md (revised, all 6 open questions resolved), horizontal-plan.md,
vertical-plan.md (5 slices, confirmed by you), research-brief.md, grill-record.md

## Part 1: Executive Summary

Auriga's router (`src/router/`) works, but only inside one specific Multica workspace —
9 agent UUIDs and 17 project UUIDs are hand-typed into `src/router/lib/config.mjs`, and
the router shells out directly to the `multica` and `gh` CLIs from `src/router/lib/multica.mjs`.
There is no path where Auriga runs without that specific workspace existing. This epic
extracts two adapter interfaces — `backlogAdapter` (task CRUD/status/comment/PR-linkage)
and `spawnAdapter` (dispatch + lane discovery) — so the router's already-pure decision
core (`lib/core.mjs`, untouched by this epic) can run against ANY implementation of those
shapes: the real Multica-backed one (preserving today's live behavior exactly), an
in-memory stub (making "runs standalone" literally testable), and a documented
not-yet-implemented `pantheon-v2-l2` stub (the only sanctioned future path to Pantheon,
intentionally unbuilt here).

**How your feedback changed the plan:**
- The GitHub PR-discovery calls (`ghOpenPrs`/`ghListRepos`/`ghPrs`) stay inside
  `backlogAdapter` rather than becoming a third `vcsAdapter` — smaller diff, no
  undocumented third adapter kind, revisit only if a second VCS is ever needed.
- **`spawnAdapter` carries NO provisioning method, hook, or middleware slot of any
  kind.** Your explicit correction: Auriga's core must never pre-build a concept for a
  tool (Vulcan) it doesn't yet need — that capability, if and when it's needed, is a
  future consumer's implementation detail, discovered when actually built, never
  designed into Auriga pre-emptively. `lib/vulcan-hook.mjs` stays untouched, out of
  scope, confirmed dead code.
- The queue UI is confirmed deferred to a separate, later epic — its future shape (a
  v0-style, LLM-in-browser, shadcn/ui-based self-building UI) is recorded in `VISION.md
  §④` so it isn't lost before its turn.
- Lane discovery stays static/adapter-owned config for this epic; dynamic discovery is
  VISION.md §②'s separate near-term goal.
- Adapter implementations are plain factory-function modules (`createXAdapter(cfg)`
  returning a frozen object literal), never ES6 classes — matching this codebase's
  actual convention (zero `class` declarations exist anywhere in it today).

**Key decisions now locked:**
1. Two adapters only: `backlogAdapter`, `spawnAdapter`. (confirmed)
2. `backlogAdapter` absorbs GitHub PR-discovery. (confirmed)
3. No provisioning concept anywhere in Auriga's core. (confirmed, generalizes beyond Vulcan)
4. Static, adapter-owned lane config for this epic. (confirmed)
5. `pantheon-v2-l2` as the stub adapter directory name. (confirmed)
6. Plain factory-function modules, no classes. (confirmed)
7. UI stays out of this epic. (confirmed)
8. **Zero live-Multica dependency anywhere in this epic's verification, permanently
   — not just for now.** Multica is one implementation behind the adapter; mocked/
   in-memory testing is equivalent to testing against it, not a lesser substitute.
   Phase 4's cutover is proven via the existing mocked regression suite plus a new
   in-memory test set of profiles/runners, never a live board. Real end-to-end
   testing across live Pantheon plugin surfaces is separate, later, Pantheon-owned
   work (targeted this weekend) — this epic's job is only to make that eventual
   swap (stub/mock → real `pantheon-v2-l2` adapters) a clean drop-in. (confirmed)

**Implementation strategy in brief:** build the interfaces and stub adapters first
(cheapest possible proof the shape is right, zero risk to the live router) — then build
and isolation-test both Multica-backed adapters — then, and only then, cut the live
router over to the new boundary in one concentrated slice, backed by the full existing
26+-test regression suite — then close with the `pantheon-v2-l2` stub and doc updates.

```
PRODUCT GOALS:
  Success metrics:
    - Standalone smoke test passes with zero execFileSync/process calls attempted
    - All 6 existing test files (26+ assertions) pass unchanged after the cutover
    - Zero direct imports of a vendor-specific module (Multica CLI, gh CLI, Vulcan)
      outside that vendor's own adapter implementation file
  Non-goals: vcsAdapter split, dynamic lane discovery, real pantheon-v2-l2
    implementation, the queue UI, provisioning of any kind — all explicitly deferred
  Stakeholders: you (sole contributor/operator per kickoff context); the eventual
    Pantheon-side consumer of pantheon-v2-l2 (not yet built, not a stakeholder of
    THIS epic's execution)
```

## Part 2: Detailed Approach

### Phase 1: Interfaces + Stub Adapters (maps to Vertical Slice 1)

**Goal:** Define the two adapter shapes and ship in-memory stub implementations, proving
"runs standalone" is real and testable — with zero changes to the live router.
**Depends on:** nothing (first phase)

#### Changes

1. **`src/router/lib/adapters/backlog-adapter.mjs`** (CREATE)
   - JSDoc `@typedef BacklogAdapter` documenting the shape: `listIssues(projectId)`,
     `listAllProjectIds()`, `getIssueRuns(id)`, `getIssuePullRequests(id)`,
     `assignIssue(id, agent)` — wait, per Part 1 decision, dispatch actions
     (`assignIssue`/`rerunIssue`/`unassignIssue`) belong to `spawnAdapter`, not
     `backlogAdapter`. `backlogAdapter`'s methods: `listIssues(projectId)`,
     `listAllProjectIds()`, `getIssueRuns(id)`, `getIssuePullRequests(id)` (includes
     gh-backed PR discovery internally), `setIssueStatus(id, status)`,
     `commentOnIssue(id, body)`.
   - No implementation — this file is the contract only, exporting the typedef for
     other files to reference in their own JSDoc `@implements` comments (a
     documentation convention, not an enforced TS interface).
   - Edge cases to handle in the CONTRACT (documented, not implemented here):
     `listIssues` must support pagination internally (caller never sees pages);
     `getIssuePullRequests` may return an empty array (no linked PR yet, not an error).

2. **`src/router/lib/adapters/spawn-adapter.mjs`** (CREATE)
   - JSDoc `@typedef SpawnAdapter`: `dispatch(issue, lane)`, `describeLanes()`,
     `assignIssue(id, agent)`, `rerunIssue(id)`, `unassignIssue(id)`.
   - Explicitly documented: **no provisioning method exists on this shape, and none
     should ever be added** — a one-line comment citing this decision so a future
     contributor doesn't "helpfully" re-add it.

3. **`src/router/lib/adapters/README.md`** (CREATE)
   - Explains the two-adapter model, cross-references `.pHive/CONTEXT.md` and
     `.pHive/cross-cutting-concerns.yaml`'s `adapter-boundary-integrity` concern.
   - States the "no pre-emptive integrations" rule in the same terms as the Vulcan
     decision, generalized: don't add a method/hook for a tool Auriga doesn't need yet.

4. **`src/router/lib/adapters/stub/backlog.mjs`** (CREATE)
   - `createStubBacklogAdapter(seedData = {})` → returns a frozen object implementing
     `backlogAdapter`, backed by an in-memory `Map` keyed by issue id. `seedData` lets
     tests pre-populate issues/runs/PRs.
   - Every method is synchronous-return-a-Promise (matches the async shape the Multica
     adapter will need, so both are drop-in compatible for `cycle()`, which already
     awaits its `mca` calls).

5. **`src/router/lib/adapters/stub/spawn.mjs`** (CREATE)
   - `createStubSpawnAdapter()` → returns a frozen object implementing `spawnAdapter`.
     `dispatch()` and the assign/rerun/unassign methods record their calls to an
     internal array (`.calls`) instead of doing anything — lets tests assert "cycle()
     tried to dispatch issue X to lane Y" without any external system.
   - `describeLanes()` returns a small hardcoded fixture lane map (not the real
     production one — that's Phase 3's Multica-backed adapter's job).

#### Interfaces

```js
/**
 * @typedef {Object} BacklogAdapter
 * @property {(projectId: string) => Promise<Issue[]>} listIssues
 * @property {() => Promise<string[]>} listAllProjectIds
 * @property {(issueId: string) => Promise<Run[]>} getIssueRuns
 * @property {(issueId: string) => Promise<PullRequest[]>} getIssuePullRequests
 * @property {(issueId: string, status: string) => Promise<void>} setIssueStatus
 * @property {(issueId: string, body: string) => Promise<void>} commentOnIssue
 */

/**
 * @typedef {Object} SpawnAdapter
 * @property {(issue: Issue, lane: string) => Promise<DispatchResult>} dispatch
 * @property {() => LaneMap} describeLanes
 * @property {(issueId: string, agent: string) => Promise<void>} assignIssue
 * @property {(issueId: string) => Promise<void>} rerunIssue
 * @property {(issueId: string) => Promise<void>} unassignIssue
 * // NOTE: intentionally no provisioning method. See adapters/README.md.
 */
```

#### Validation

- Unit test: every stub adapter method is callable and returns the documented shape
  (empty defaults when unseeded).
- Unit test (`standalone-smoke.test.mjs`): spy on `node:child_process.execFileSync`
  (or equivalent), run `cycle()` with both stub adapters injected, assert the spy is
  never called.
- What could silently break: if a stub method's return shape subtly diverges from what
  `lib/core.mjs` expects (e.g., missing a field `detectRunCompletions` reads), `cycle()`
  could throw deep in decision logic with a confusing stack trace. Mitigation: the stub
  test asserts shape against the SAME fixtures `test/support/mock-mca.mjs` already uses,
  since that mock has been battle-tested against `lib/core.mjs` for months.

---

### Phase 2: Multica-Backed Backlog Adapter (maps to Vertical Slice 2)

**Goal:** Port `lib/multica.mjs`'s read/write issue surface + gh PR-discovery into
`createMulticaBacklogAdapter`, tested in isolation against mocked CLI output.
**Depends on:** Phase 1 (implements the same shape)

#### Changes

1. **`src/router/lib/adapters/multica/backlog.mjs`** (CREATE)
   - `createMulticaBacklogAdapter(cfg)` where `cfg` carries `{ cli, profile, ghCli }`
     (defaults to today's `MULTICA_CLI`/`MULTICA_PROFILE`/`GH_CLI` env-var behavior).
   - Ports verbatim: `listIssues` (with its existing pagination loop and 100k-offset
     safety stop), `listAllProjectIds`, `getIssueRuns` (was `issueRuns`),
     `getIssuePullRequests` — this one now INTERNALLY calls both the Multica
     `issue pull-requests` command AND the gh-backed `ghOpenPrs`/`ghPrs` (per the
     Open Q1 resolution: PR discovery lives inside `backlogAdapter`), `setIssueStatus`
     (was `issueStatus`), `commentOnIssue` (was `issueComment`).
   - Also ports `ghListRepos` as an internal helper used by `getIssuePullRequests`'s
     repo-discovery fallback (was a top-level export in `multica.mjs`; becomes private
     to this adapter since nothing outside the backlog adapter needs it directly).
   - Carries forward the exact `cleanEnv()` logic (deleting `MULTICA_TOKEN`/
     `MULTICA_PAT_TOKEN`/`MULTICA_WORKSPACE_ID` from a cloned env) — this is a real,
     load-bearing behavior (stale env values 404), not incidental.
   - Cites the mined status-mapping notes from `src/engine/adapters/multica/index.ts`
     (commit `f4847ee`) as source comments where the empirical Multica-status-enum
     mapping matters — e.g. the difference between `blocked` and `backlog` states.

2. **`src/router/lib/config-substrate.mjs`** (CREATE) — first half of the config split
   - `AGENTS`, `PROJECT_NAMES`, `PROJECT_IDS` move here verbatim, including the
     `KNOWN GAP` comment about 7 unmapped project names — carried forward unchanged,
     not "fixed" (explicitly out of scope per VISION.md).
   - `lib/config.mjs` (MODIFY): removes the three exports above, re-exports them from
     `config-substrate.mjs` for one release cycle if any other file still imports them
     directly (grep first — expected to be zero, since only `multica.mjs`/
     `auriga-router.mjs` reference `AGENTS`/`PROJECT_IDS` today, both touched by this
     epic anyway).

#### Interfaces

`createMulticaBacklogAdapter(cfg)` returns an object matching `BacklogAdapter` exactly
(same method names/arity as Phase 1's typedef) — this is the contract-compliance check
Phase 2's tests exist to prove.

Error conditions: any CLI failure (non-zero exit, malformed JSON) is caught internally
and either returns an empty array/null (matching today's `lib/multica.mjs` behavior for
list/read methods) or rethrows for write methods (`setIssueStatus`, `commentOnIssue`) —
exactly preserving today's asymmetric error handling (reads degrade gracefully, writes
surface failures) documented in the research brief.

#### Validation

- Extend `test/support/mock-mca.mjs`'s pattern into a new
  `test/backlog-adapter.test.mjs`: feed the adapter mocked CLI stdout for each method,
  assert correct parsing, pagination termination, and the `cleanEnv()` env-scrubbing.
- Specifically test the pagination edge case that motivated `listIssues`'s existing
  loop (a project with more than one page of issues) — this is a real prior bug
  (`PAN-6952` and others were invisible before pagination was added, per the code's
  own comment) and must not regress.
- What could silently break: if `getIssuePullRequests`'s internal gh-fallback logic is
  ported incorrectly, PR discovery could silently return empty instead of erroring —
  this would look like "no open PR" to the state machine and stall the review lane
  invisibly. Mitigation: a dedicated test case with a non-empty gh-mocked response.

---

### Phase 3: Multica-Backed Spawn Adapter (maps to Vertical Slice 3)

**Goal:** Port the assign/rerun/dispatch logic and lane maps into
`createMulticaSpawnAdapter`, tested in isolation.
**Depends on:** Phase 2 sequenced first only for narrative ordering — functionally
independent, could be built in parallel.

#### Changes

1. **`src/router/lib/adapters/multica/spawn.mjs`** (CREATE)
   - `createMulticaSpawnAdapter(cfg)` — `dispatch(issue, lane)` wraps today's
     assign-then-verify-a-run-started logic (currently inline in
     `auriga-router.mjs`'s dispatch loop, using `CAPS.verifyDelayMs`); `assignIssue`,
     `rerunIssue`, `unassignIssue` port verbatim from `lib/multica.mjs`.
   - `describeLanes()` returns the lane map assembled from `config-substrate.mjs`'s
     `PROJECT_LANE`/`DEFAULT_LANE`/`HIVE_LANE`/`REVIEW_LANE` (moved here from
     `lib/config.mjs` in this phase — see Changes item 2 below) plus `RUNTIME_CAP`.
   - **Explicitly does NOT implement or expose any provisioning method.** A one-line
     comment states this is intentional (cross-references
     `src/router/lib/adapters/README.md`).

2. **`src/router/lib/config-substrate.mjs`** (MODIFY — completes the split from Phase 2)
   - `PROJECT_LANE`, `DEFAULT_LANE`, `HIVE_LANE`, `REVIEW_LANE`, `REVIEW_REPO_OWNER`,
     `REVIEW_SEARCH_REPOS`, `RUNTIME_CAP` move here from `lib/config.mjs`, unchanged.
   - `lib/config.mjs` (MODIFY): keeps `REVIEW_SQUAD_RULES`, `CAPS`, `HUMAN_NAMES`
     unchanged — these are substrate-agnostic policy, not moved.

#### Interfaces

`createMulticaSpawnAdapter(cfg)` returns an object matching Phase 1's `SpawnAdapter`
typedef exactly. `describeLanes()`'s return shape (a `LaneMap`) is newly formalized —
document it as `{ [projectId: string]: string[] }` for `PROJECT_LANE`-style entries
plus `default: string[]` and `hive: string[]` keys for the two override lanes.

#### Validation

- New `test/spawn-adapter.test.mjs`: assert `describeLanes()` output is
  structurally identical to today's `PROJECT_LANE`/`DEFAULT_LANE`/`HIVE_LANE`/
  `REVIEW_LANE` constants (a snapshot-style equality test against the moved values).
- Assert `dispatch()` preserves the existing assign→verify-run-started→force-rerun-if-
  not-started sequence (currently in `auriga-router.mjs`, moves into this adapter).
- What could silently break: if the lane-map move introduces a typo in a project UUID,
  routing would silently misfire for that one project — hard to catch by inspection.
  Mitigation: the snapshot-equality test above catches any accidental transcription
  error at the byte level.

---

### Phase 4: Router Wiring Cutover (maps to Vertical Slice 4 — the critical phase)

**Goal:** Rewire `cycle()`'s options bag and all ~25 `mcaImpl.*` call sites to the new
adapter boundary; prove zero behavior change via the full existing regression suite.
**Depends on:** Phases 2 and 3 (needs both real adapters to exist)

#### Changes

1. **`src/router/auriga-router.mjs`** (MODIFY — the concentrated-risk file)
   - `cycle()`'s options bag: `mca` parameter replaced by `backlog` + `spawn`
     (defaulting to `createMulticaBacklogAdapter()`/`createMulticaSpawnAdapter()` in
     `main()`, exactly preserving live behavior with zero config changes needed for
     the existing supervised deployment).
   - Every `mcaImpl.*` call site re-pointed:
     - Unblock pass (`ghPrs` guard) → `backlog.getIssuePullRequests`
     - Cascade re-dispatch pass (`ghPrs` guard) → `backlog.getIssuePullRequests`
     - False-done/review-scan pass (`ghListRepos`/`ghOpenPrs` populate `openPrsAll`)
       → `backlog.getIssuePullRequests` (aggregated across projects) — this pass's
       exact aggregation logic is preserved, just re-pointed to the new method name
     - Dispatch pass (`assignIssue`, verify-run-started, force-rerun) →
       `spawn.dispatch`
     - Review lane (`ghOpenPrs`, `issueComment`) → `backlog.getIssuePullRequests` +
       `backlog.commentOnIssue`
     - State-machine reads (`issueRuns`, `issuePullRequests`) → `backlog.getIssueRuns`,
       `backlog.getIssuePullRequests`
   - No change to `lib/core.mjs` — every call into `core.*` functions is unchanged,
     since they already only take plain issue/run/PR-shaped objects.

#### Interfaces

No new interfaces — this phase is pure consumption of Phase 1-3's contracts. The one
notable signature change: `cycle(opts)`'s `opts.mca` is renamed/split to
`opts.backlog`/`opts.spawn` — a breaking change to `cycle()`'s own API, but `cycle()`
has exactly one caller (`main()`, in-file) and one test consumer
(`router-cycle.e2e.test.mjs`, updated in this phase), so the blast radius is fully
contained within this repo.

#### Validation

- **All 6 existing test files must pass unchanged in behavior** (test file contents
  may need updating to construct `{ backlog, spawn }` instead of `{ mca }`, but
  assertions about ROUTING DECISIONS must not change) — this is the epic's
  acceptance bar, not just this phase's.
- **New `test/cutover-e2e.test.mjs`** — the real acceptance test for this phase, per
  your explicit correction: NO live or mocked-CLI Multica dependency of any kind, no
  "dry run against a real board." Instead, a richer in-memory fixture set — a small
  **test set of profiles (personas) and runners (dispatch targets/lanes)** — feeds
  the stub `backlog`/`spawn` adapters from Phase 1, and `cycle()` is run end-to-end
  against that fixture set through the NEWLY CUT-OVER `auriga-router.mjs`, asserting
  the full routing/state-machine/dispatch pipeline behaves correctly with zero
  external process calls. This supersedes the "manual dry-run against Multica"
  approach from the design-discussion draft — you were explicit that Multica should
  never be needed or desired for THIS epic's verification: it's just one
  implementation behind the adapter, and testing against mocked/in-memory data is
  equivalent, not a lesser substitute.
- `src/router/test/fixtures/test-profiles-runners.mjs` (CREATE, referenced by
  `cutover-e2e.test.mjs`) — a small, realistic fixture set of persona/runner shapes
  covering the states the state machine cares about (todo, in_progress-with-done-run,
  in_review-with-merged-PR, blocked-with-cleared-dep, etc.), reused across Phase 1's
  standalone smoke test and Phase 4's cutover e2e test so both exercise the same
  realistic data rather than each inventing thinner ad hoc fixtures.
- What could silently break: a call site re-pointed to the wrong adapter method (e.g.
  a read accidentally pointed at a stub-shaped stand-in, or an argument order swap
  during the mechanical rename) would not necessarily throw — it could silently
  change WHICH issues get dispatched. This is exactly what the full regression suite
  AND `cutover-e2e.test.mjs` exist to catch; treat any test failure in this phase as
  a signal to re-check the specific call site's mapping, not to adjust the test's
  expectations.
- **Explicitly out of scope for this epic:** real end-to-end verification against a
  live Multica/Pantheon board. Per your direction, that's a separate, later effort —
  Pantheon's own e2e testing across plugin surfaces (targeted by you for this
  weekend) — and this epic's job is only to make that eventual real-adapter swap a
  clean drop-in (stub/mock adapters → real `pantheon-v2-l2` adapters, same shape),
  not to perform that live testing itself.

---

### Phase 5: pantheon-v2-l2 Stub + Docs (maps to Vertical Slice 5)

**Goal:** Add the documented Pantheon stub adapter and update project docs so the
epic's "Done" bar (design-discussion.md §1) is fully met.
**Depends on:** Phase 1 only (functionally independent of Phases 2-4)

#### Changes

1. **`src/router/lib/adapters/pantheon-v2-l2/index.mjs`** (CREATE)
   - Implements both `BacklogAdapter` and `SpawnAdapter` shapes; every method throws
     a `NotImplementedError`-shaped error (`{ name: 'NotImplementedError', message:
     'pantheon-v2-l2 adapter is a documented stub — see README.md' }`) rather than
     silently returning empty/success — a stub that fails loudly is safer than one
     that looks like it's working.

2. **`src/router/lib/adapters/pantheon-v2-l2/README.md`** (CREATE)
   - States plainly: this is the ONLY sanctioned path from Auriga to Pantheon; it is
     intentionally unbuilt in this epic; building the real implementation is a future,
     separate epic (Pantheon-side, not Auriga-side, per the north_star's "Auriga does
     not communicate with other things directly" principle).

3. **`.pHive/CONTEXT.md`** (MODIFY)
   - Add terminology entries for `backlogAdapter`, `spawnAdapter`, `pantheon-v2-l2` —
     the vocabulary this epic introduces.

4. **`VISION.md`** (MODIFY)
   - §① "Current — what actually runs today" gets a note that the adapter interface
     has landed (once this epic ships) — keeps VISION.md's "what's real vs. aspirational"
     framing accurate.

#### Interfaces

`pantheon-v2-l2/index.mjs` exports `createPantheonV2L2BacklogAdapter()` and
`createPantheonV2L2SpawnAdapter()`, matching Phase 1's typedefs exactly (so a future
implementer has a compiling — well, JSDoc-valid — starting point, not a blank file).

#### Validation

- `test/pantheon-l2-stub.test.mjs`: every method call is asserted to throw the
  documented `NotImplementedError` shape — proves the stub is inert, not silently
  half-working.
- What could silently break: nothing — this phase touches no live code path.

## Part 3: Verification Plan

```
Phase 1 verification:
  Automated:
    - node:test: stub adapters satisfy BacklogAdapter/SpawnAdapter shape contracts
    - node:test: standalone-smoke.test.mjs — cycle() with stub adapters only, zero
      execFileSync calls attempted
  Manual: none needed — fully covered by automation
  Tools: node:test (built-in), a child_process spy/mock for the smoke test
  Platforms: N/A (headless Node)

Phase 2 verification:
  Automated:
    - node:test: backlog-adapter.test.mjs against mocked multica/gh CLI output,
      including pagination and status-mapping edge cases
  Manual: none needed
  Tools: node:test, extending test/support/mock-mca.mjs
  Platforms: N/A

Phase 3 verification:
  Automated:
    - node:test: spawn-adapter.test.mjs, including the lane-map snapshot-equality
      check against today's PROJECT_LANE/DEFAULT_LANE/HIVE_LANE/REVIEW_LANE values
  Manual: none needed
  Tools: node:test
  Platforms: N/A

Phase 4 verification:
  Automated:
    - ALL 6 existing test files (core, cascade, descdeps, slugkey, squad,
      router-cycle.e2e) — 26+ assertions — pass unchanged
    - NEW cutover-e2e.test.mjs — cycle() run end-to-end through the cut-over
      auriga-router.mjs against an in-memory test set of profiles/runners
      (test/fixtures/test-profiles-runners.mjs), zero external process calls
  Manual: NONE — per your explicit direction, no live/mocked-CLI Multica
    dependency anywhere in this epic's verification. Real end-to-end testing
    against a live board is separate, later, Pantheon-owned work (targeted this
    weekend), not this epic's job.
  Tools: node:test
  Platforms: N/A

Phase 5 verification:
  Automated:
    - node:test: pantheon-l2-stub.test.mjs — every method throws the documented
      NotImplementedError shape
  Manual: none needed
  Tools: node:test
  Platforms: N/A
```

**Verification coverage matrix:**

```
| Acceptance Criterion                                   | Test Type   | Tool      | Phase |
|----------------------------------------------------------|-------------|-----------|-------|
| Stub adapters satisfy the interface shape                 | Unit        | node:test | 1     |
| cycle() runs standalone with zero external process calls  | Unit (spy)  | node:test | 1     |
| Multica backlog adapter preserves pagination/status-mapping| Unit        | node:test | 2     |
| Multica spawn adapter preserves exact lane-map semantics   | Unit        | node:test | 3     |
| Full router cutover preserves all existing routing behavior| Regression  | node:test | 4     |
| pantheon-v2-l2 stub is inert (throws, not silent no-op)    | Unit        | node:test | 5     |
```

**What's NOT being verified and why:**
- **Live Multica/Pantheon integration end-to-end** — deliberately and permanently NOT
  in scope for this epic, per your explicit direction. Multica is just one
  implementation behind the adapter (reached, in the real Pantheon deployment, through
  the `pantheon-v2-l2` adapter this epic stubs but does not build) — so from this
  epic's point of view, verifying against it is never needed, and mocked/in-memory
  verification is equivalent, not a lesser substitute. Real end-to-end testing across
  Pantheon's plugin surfaces is separate, later, Pantheon-owned work (you're targeting
  this weekend) — this epic's job is only to make the eventual swap from
  stub/mock adapters to real `pantheon-v2-l2` adapters a clean drop-in, which the
  identical `BacklogAdapter`/`SpawnAdapter` shapes across both implementations
  already guarantee.
- **Load/concurrency testing** — not applicable; Auriga is confirmed single-instance
  per north_star's scale answer, and this epic doesn't change the concurrency model.
- **The pantheon-v2-l2 adapter's real behavior** — there isn't any; it's a stub by
  design (Phase 5 verifies it throws, not that it does anything useful).

## Part 3b: Cross-Cutting Concerns

- **Error handling strategy:** unchanged from today — read methods degrade gracefully
  (empty array/null + stderr log), write methods (`setIssueStatus`, `commentOnIssue`,
  `assignIssue`, `rerunIssue`, `unassignIssue`) propagate errors to the caller. This
  asymmetry is preserved verbatim, not redesigned, in Phases 2-3.
- **Migration plan:** none — no persisted data, no schema. The only "migration" is the
  `lib/config.mjs` → `lib/config-substrate.mjs` split, which is a pure code move with
  no runtime data implications (confirmed no external file reads `config.mjs`'s
  exports by path).
- **Rollback plan:** each phase is an independently revertable commit (per your
  `atomic-prs` preference — real merge commits, not squashed). If Phase 4's cutover
  surfaces a production issue, reverting that single commit restores the pre-cutover
  `auriga-router.mjs` while Phases 1-3's new adapter code sits unused but harmless.
- **Performance implications:** none expected — the adapter layer is a thin
  pass-through (same CLI calls, same argument shapes, just re-homed into named
  functions instead of a flat module). No new network calls, no new serialization.
- **Documentation impact:** `README.md` (quickstart section references `lib/multica.mjs`
  by name — needs a pointer update), `src/router/README.md` (Files/paths section lists
  `lib/config.mjs`, `lib/multica.mjs` — needs the new adapter paths added),
  `VISION.md` §① (Phase 5), `.pHive/CONTEXT.md` (Phase 5, new terminology). All four
  flagged as CREATE/MODIFY targets above or in Phase 5.
- **Security considerations:** the `cleanEnv()` token-scrubbing behavior (deleting
  `MULTICA_TOKEN`/`MULTICA_PAT_TOKEN`/`MULTICA_WORKSPACE_ID` from the child process env)
  is security-relevant (stale tokens 404, but a LEAKED stale token in a subprocess env
  would be worse) and must be preserved byte-for-byte in Phase 2 — flagged explicitly
  in that phase's Changes section, not left implicit.

## Part 4: File Change Manifest

```
FILES:

CREATE:
  - src/router/lib/adapters/backlog-adapter.mjs — BacklogAdapter shape contract (JSDoc)
  - src/router/lib/adapters/spawn-adapter.mjs — SpawnAdapter shape contract (JSDoc)
  - src/router/lib/adapters/README.md — two-adapter model + no-pre-emptive-integrations rule
  - src/router/lib/adapters/stub/backlog.mjs — createStubBacklogAdapter
  - src/router/lib/adapters/stub/spawn.mjs — createStubSpawnAdapter
  - src/router/lib/adapters/multica/backlog.mjs — createMulticaBacklogAdapter
  - src/router/lib/adapters/multica/spawn.mjs — createMulticaSpawnAdapter
  - src/router/lib/config-substrate.mjs — AGENTS/PROJECT_IDS/lane maps (moved, unchanged values)
  - src/router/lib/adapters/pantheon-v2-l2/index.mjs — documented stub, throws NotImplementedError
  - src/router/lib/adapters/pantheon-v2-l2/README.md — sanctioned-path statement
  - src/router/test/stub-adapters.test.mjs
  - src/router/test/standalone-smoke.test.mjs
  - src/router/test/backlog-adapter.test.mjs
  - src/router/test/spawn-adapter.test.mjs
  - src/router/test/pantheon-l2-stub.test.mjs
  - src/router/test/cutover-e2e.test.mjs — Phase 4's acceptance test: cycle() through
    the cut-over router against the in-memory profiles/runners fixture set, NO live
    or mocked-CLI Multica dependency
  - src/router/test/fixtures/test-profiles-runners.mjs — shared realistic fixture
    set (profiles/personas + runners/lanes across all state-machine states), reused
    by both standalone-smoke.test.mjs and cutover-e2e.test.mjs

MODIFY:
  - src/router/auriga-router.mjs — cycle() options bag + ~25 mcaImpl.* call sites (Phase 4)
  - src/router/lib/config.mjs — substrate exports removed (moved to config-substrate.mjs),
    REVIEW_SQUAD_RULES/CAPS/HUMAN_NAMES unchanged
  - src/router/test/router-cycle.e2e.test.mjs — construct {backlog, spawn} instead of {mca}
  - .pHive/CONTEXT.md — new adapter terminology (Phase 5)
  - VISION.md — §① note that adapter interface has landed (Phase 5)
  - README.md — quickstart pointer update (Phase 5, doc-impact item)
  - src/router/README.md — Files/paths section update (Phase 5, doc-impact item)

DELETE:
  (none — lib/multica.mjs's logic is ported, not deleted outright in this epic; see
  Part 7 "Where Are We Over-Engineering?" for whether lib/multica.mjs itself should be
  deleted once Phase 4 lands, or left as a thin re-export for one release)

UNCHANGED (but affected):
  - src/router/lib/core.mjs — zero changes; every call site into it is preserved
    exactly, since it already only consumes plain issue/run/PR-shaped objects
  - src/router/lib/vulcan-hook.mjs — explicitly untouched, confirmed dormant/out of
    scope (your Vulcan decision)
  - src/router/scripts/*, src/router/agents/*, src/router/supervisor.sh — no
    interaction with the adapter boundary
```

## Part 5: Risk Registry

| # | Risk | Severity | Likelihood | Mitigation | Owner |
|---|------|----------|------------|------------|-------|
| 1 | Phase 4 call-site re-pointing introduces a subtle routing regression (wrong method, swapped args) that doesn't throw but silently misroutes issues | High | Medium | Full 6-file/26+-assertion regression suite must pass unchanged before Phase 4 is done; new `cutover-e2e.test.mjs` against a realistic in-memory profiles/runners fixture set as a second, richer catch — no live Multica dependency (per your direction) | Phase 4 / developer |
| 2 | `cleanEnv()`'s token-scrubbing behavior is dropped or altered during the Phase 2 port | High | Low | Explicit Changes-section callout in Phase 2; a dedicated test asserting the three env vars are absent from the child process env | Phase 2 / developer |
| 3 | The 7-unmapped-project-names known gap (VISION.md) gets "fixed" incidentally during the config split, silently changing routing for those (currently-inert) entries | Medium | Low | Snapshot-equality test in Phase 3 asserts the moved config is byte-identical to today's, including the gap | Phase 3 / developer |
| 4 | A future contributor re-adds a provisioning hook to `spawnAdapter`, reintroducing the exact coupling this epic removes | Medium | Medium (this is a real recurring temptation — it already happened once, in this epic's own first draft) | Explicit comment in `spawn-adapter.mjs` + `adapters/README.md` documenting the decision and why; `adapter-boundary-integrity` cross-cutting concern gates future stories on this | Phase 1 / all future stories |
| 5 | `pantheon-v2-l2`'s stub is implemented as silently-succeeding no-ops instead of loud failures, masking the fact that it's not real when someone eventually wires it in | Medium | Low | Phase 5 explicitly specifies throw-not-silent-success; test asserts every method throws | Phase 5 / developer |
| 6 | Stub adapters' return shapes drift from what `lib/core.mjs` actually expects (untested edge case in `detectRunCompletions` etc.), causing standalone mode to pass its own test but still be subtly broken | Medium | Low | Phase 1's stub tests reuse the same fixtures `test/support/mock-mca.mjs` already validates against `lib/core.mjs` | Phase 1 / developer |
| 7 | Documentation (README.md, src/router/README.md, VISION.md) drifts from the new adapter reality if Phase 5's doc updates are skipped or rushed | Low | Medium | Explicitly listed as MODIFY targets in Part 4; cross-cutting-concerns.yaml's `documentation` concern applies to this epic's stories | Phase 5 / developer |

**Detailed mitigation for Risk #1 (high severity):** Phase 4 is the only phase in this
epic where a mistake can reach the live supervised production process. The mitigation
is structural, not just "be careful": Phases 1-3 exist specifically so that by the time
Phase 4 happens, both real adapters are already independently proven correct against
mocked CLI output — Phase 4's job is ONLY re-pointing call sites, not writing new logic.
The full regression suite (which asserts on ROUTING DECISIONS, not implementation
details) plus the new `cutover-e2e.test.mjs` in-memory fixture test are the actual
safety net; if any of the 6 existing files or the new cutover test fails after Phase
4's changes, treat it as a signal to re-audit the specific call site's adapter-method
mapping against Part 2 Phase 4's explicit list, not as a reason to adjust the test.
Note: this mitigation is entirely in-memory/mocked by design — per your explicit
direction, no live Multica board is ever used to validate this epic.

## Part 6: Dependency Map

```
INTERNAL DEPENDENCIES:
  Phase 2 depends on Phase 1 (implements BacklogAdapter shape defined there)
  Phase 3 depends on Phase 1 (implements SpawnAdapter shape defined there)
  Phase 4 depends on Phase 2 AND Phase 3 (needs both real adapters to construct
    main()'s default backlog/spawn instances)
  Phase 5 depends on Phase 1 only (pantheon-v2-l2 implements the same shapes,
    functionally independent of Phases 2-4 — see vertical-plan.md Moldability Notes)

EXTERNAL DEPENDENCIES:
  CLI: multica (via execFileSync) — what today's live behavior depends on; Phase 2's
    adapter is a thin wrapper, same dependency, just re-homed
  CLI: gh (via execFileSync) — same, for PR discovery
  No new external dependencies introduced by this epic (zero new npm packages,
    zero new CLIs)

BLOCKING QUESTIONS:
  (none — all 6 open questions from design-discussion.md were resolved in your
  review; no unresolved blockers remain)
```

## Part 7: Elicitation — Stress-Testing This Plan

### Why Won't This Work?

1. **Failure:** Phase 4's call-site re-pointing has an off-by-one or swapped-argument
   bug that the existing test suite doesn't catch because the suite tests ROUTING
   DECISIONS, not the exact adapter-method call sequence.
   **Trigger:** a call site is re-pointed to a method with a similar name/shape but
   subtly different semantics (e.g. `backlog.getIssuePullRequests` called where
   `backlog.getIssueRuns` was needed — both return arrays, both plausible in context).
   **Impact:** wrong routing decisions in production, hard to notice because the code
   runs without error.
   **Signal:** the regression suite's assertions are on OUTPUT (which issues get
   dispatched/transitioned), so a swap that changes behavior WOULD fail a test — this
   failure mode is really "a swap that happens to not change any test's asserted
   scenario." Detectable only by a case the existing 26+ assertions don't cover.
   **Our answer:** the mitigation is the manual dry-run decision-log diff in Phase 4 —
   a real board's decision set is far richer than the test fixtures, so a
   narrow-scenario bug is more likely to surface there. We accept this isn't 100%
   airtight and treat the dry-run diff as a required, not optional, step.

2. **Failure:** the `pantheon-v2-l2` stub gets built out incrementally over time by
   well-meaning future stories until it's a half-real integration, defeating the
   purpose of this epic.
   **Trigger:** a future story needs "just one small thing" from Pantheon and it seems
   easier to add a real method to the stub than to properly scope a new epic.
   **Impact:** reintroduces exactly the direct-coupling problem this epic exists to
   prevent, but gradually and without a clear moment where anyone decided to do that.
   **Signal:** a PR touching `pantheon-v2-l2/index.mjs` that doesn't ALSO update its
   README's "intentionally unbuilt" statement.
   **Our answer:** the `adapter-boundary-integrity` cross-cutting concern
   (`.pHive/cross-cutting-concerns.yaml`) already gates every future story on exactly
   this question. This epic's job is to make sure that concern exists and is worded
   correctly — which it already does, from kickoff.

3. **Failure:** the config split (`lib/config.mjs` → `lib/config-substrate.mjs`)
   breaks something that imports the moved constants by a path we didn't find.
   **Trigger:** a script outside `src/router/` (e.g. in `scripts/`) imports
   `lib/config.mjs`'s `AGENTS` or `PROJECT_IDS` directly.
   **Impact:** an ImportError at runtime for whatever script does this.
   **Signal:** would surface immediately (import errors are loud, not silent) —
   this is a LOW-impact failure mode precisely because it's impossible to miss.
   **Our answer:** `research-brief.md`'s codebase read found only `multica.mjs` and
   `auriga-router.mjs` (both touched by this epic anyway) referencing these constants.
   `scripts/export-human-queue.mjs` and `scripts/export-human-queue.test.mjs` were
   checked and don't import `config.mjs`. We're VERIFIED, not just assuming, on this one.

4. **Failure:** the standalone smoke test (Phase 1) gives false confidence — it proves
   `cycle()` runs without external calls, but doesn't prove the STUB adapters produce
   realistic enough data for the test to be meaningful (e.g., if the stub always
   returns an empty issue list, "cycle() completes without external calls" is trivially
   true and uninteresting).
   **Trigger:** under-seeding the stub adapter's test fixtures.
   **Impact:** a green test that doesn't actually validate much.
   **Signal:** if the smoke test's seed data doesn't include at least one issue in
   each state the state machine cares about (todo, in_progress with a done run,
   in_review with a merged PR), it's not exercising the real decision paths.
   **Our answer:** Phase 1's stub test explicitly reuses `test/support/mock-mca.mjs`'s
   existing fixture shapes (which already cover these states, since
   `router-cycle.e2e.test.mjs` already exercises them) rather than inventing new,
   possibly-thinner fixtures.

5. **Failure:** "atomic-prs" (real merge commits, your stated preference) across 5
   phases with hard sequencing (Phase 4 needs 2+3) creates a long-lived
   partially-merged state where the live router hasn't cut over yet but new adapter
   code exists unused — a window where two "ways to do it" coexist.
   **Trigger:** normal sequential delivery across 5 phases/stories.
   **Impact:** low — Phases 1-3 are purely additive (new files, zero changes to
   `auriga-router.mjs`), so this isn't actually a "two implementations fighting"
   situation, just "new code sitting unused until Phase 4." Not a real risk, listed
   here because it's the kind of thing that LOOKS like a risk on first read.
   **Our answer:** confirmed non-issue by the vertical-plan.md slicing itself — each
   phase's "NOT YET" section makes clear Phases 1-3 don't touch the live path.

### What Assumptions Are We Making?

- **VERIFIED** — `lib/core.mjs` never imports `multica.mjs` or shells out directly
  (confirmed by direct code read during research).
- **VERIFIED** — only `multica.mjs` and `auriga-router.mjs` reference the substrate
  config constants being moved (confirmed by codebase grep during research).
- **VERIFIED** — the existing test suite is 100% mocked (no live Multica/gh calls in
  CI), so Phase 4's regression bar is achievable without new test infrastructure
  (confirmed: `ci.yml` just runs `npm test`, which is `node --test`, no network).
- **VERIFIED** — `src/engine/`'s TypeScript code is fully dormant (no `tsconfig.json`,
  not referenced by any build/CI script) — confirmed via the dedicated research
  subagent pass, so mining its comments carries zero build-tooling risk.
- **ASSUMED** — `cycle()`'s options bag is the right place to inject `backlog`/`spawn`
  (rather than, say, module-level singletons). Reasonable because this is exactly the
  existing pattern (`mca` is already injected this way) and `test/router-cycle.e2e.test.mjs`
  already proves the pattern works for testing.
- **ASSUMED** — 5 stories (one per phase) is the right granularity, matching your
  `commit_granularity: medium` (feature-scoped) preference from kickoff. Could be
  finer (one story per adapter method) but that would fight your stated preference.
- **RESOLVED (was RISKY, now settled by your direction)** — the original draft assumed
  Phase 4's verification would include a manual dry-run spot-check against a live or
  freshly-mocked Multica workspace. You explicitly rejected this: Multica should never
  be needed or desired for this epic's verification — it's just one implementation
  behind the adapter, so mocked/in-memory testing is equivalent, not a lesser
  substitute. Phase 4's verification is now entirely in-memory (full regression suite
  + `cutover-e2e.test.mjs` against a realistic profiles/runners fixture set, Part 2
  Phase 4 Validation). Real end-to-end testing across live systems is separate,
  later, Pantheon-owned work — not a gap in this epic's plan.

### What's the Simplest Version?

- **Must have:** `backlogAdapter` + `spawnAdapter` interfaces, Multica-backed
  implementations, the Phase 4 cutover with regression-suite proof. Without these,
  the epic doesn't achieve its core goal (Auriga running through an adapter boundary
  instead of direct Multica coupling) at all.
- **Should have:** stub adapters + standalone smoke test (Phase 1). Technically the
  epic could ship Phases 2-4 alone and claim "adapter interface exists" — but without
  a stub implementation and a test proving it works, "runs standalone" stays an
  unverified claim, not a demonstrated one. Worth the extra phase.
- **Could cut:** Phase 5 (`pantheon-v2-l2` stub + doc updates). The core adapter work
  (Phases 1-4) is complete and correct without it — Phase 5 exists to close the
  specific "no direct Pantheon coupling, documented" requirement from your original
  kickoff brief, which is real but separable. If scope needs to shrink, Phase 5 is the
  safest cut (already flagged in vertical-plan.md's Moldability Notes).

### What Will We Wish We Had Thought Of?

- **Technical debt knowingly taken on:** `lib/multica.mjs` itself isn't deleted in this
  epic (Part 4's DELETE section is empty) — its logic is ported, not removed, leaving
  a redundant file until a follow-up cleanup. Acceptable now because deleting it
  requires confirming absolutely nothing else imports it, which is safer to verify as
  a dedicated small follow-up than to rush into this epic's Phase 4.
- **Edge cases deferred:** the `vcsAdapter` split (Open Q1) — if a second VCS is ever
  needed, `backlogAdapter`'s PR-discovery methods will need retrofitting. Safe to defer
  because no second VCS is currently in view; the interface is small enough that
  splitting it out later isn't expected to be painful.
- **Integration points not fully validated:** `pantheon-v2-l2`'s stub shape is a
  best guess at what the eventual real adapter will need — since nothing has actually
  built against it yet, the shape may need to change when that real work starts. We'll
  find out when that epic happens, not before.
- **User workflows not considered:** none identified — this epic has no end-user-facing
  surface (headless backend refactor), so there's no user workflow to have missed.

### Where Are We Over-Engineering?

- **Abstractions with only one consumer:** `pantheon-v2-l2` currently has zero real
  consumers (it's a stub). We're building it anyway because your brief explicitly asked
  for it as proof the pattern generalizes beyond Multica — not speculative, a stated
  requirement, so keeping it.
- **Error handling for unlikely scenarios:** none added beyond what's already there —
  Phase 2-3 preserve today's exact error-handling asymmetry rather than adding new
  handling "while we're in there." Deliberately resisting the urge to improve
  error handling as part of a behavior-preservation refactor.
- **Configurability that wasn't requested:** `createMulticaBacklogAdapter(cfg)` accepts
  a `cfg` object rather than reading `process.env` directly (unlike today's
  `multica.mjs`). This IS a small addition beyond strict porting — justified because
  it's what makes the adapter testable/instantiable multiple times (needed for the
  standalone-vs-live distinction this whole epic is about), not speculative
  configurability for its own sake.
- **Backward compatibility:** the one-release re-export of substrate config from
  `lib/config.mjs` (Phase 2, Changes item 2) is a small compatibility shim. Given
  research confirmed zero other consumers exist, this could arguably be cut entirely
  — flagging as a candidate simplification for Decision Point 3 below.

## Part 8: Decision Points for Sign-Off

```
DECISIONS REQUIRING SIGN-OFF:

1. [APPROACH] 5 phases mapped 1:1 to vertical-plan.md's 5 slices, sequenced
   interfaces+stubs → Multica-backlog → Multica-spawn → cutover → pantheon-v2-l2+docs
   → Affirm / Change direction

2. [SCOPE] Phase 5 (pantheon-v2-l2 + docs) is the safest item to cut if time is tight;
   Phases 1-4 alone deliver the core "adapter interface + behavior-preserved cutover"
   claim
   → Affirm / Adjust scope

3. [SIMPLIFICATION] Drop the one-release backward-compat re-export of substrate config
   from lib/config.mjs (Part 7 "Where Are We Over-Engineering?" flagged this) since
   research confirmed zero external consumers of those constants exist
   → Affirm (drop it) / Keep it as a safety margin

4. [RESOLVED — your answer] No live or mocked-CLI Multica dependency anywhere in this
   epic's verification, ever. Phase 4's acceptance bar is the full existing regression
   suite plus a new in-memory `cutover-e2e.test.mjs` driven by a realistic test set of
   profiles (personas) and runners (dispatch targets), via the stub adapters. Real
   end-to-end testing across live Pantheon plugin surfaces is separate, later,
   Pantheon-owned work (targeted this weekend) — this epic's job is only to make that
   eventual swap (stub/mock → real pantheon-v2-l2 adapters) a clean drop-in.

5. [TRADE-OFF] lib/multica.mjs stays on disk, unused-but-present, after Phase 4 lands
   (not deleted in this epic) — a small amount of dead-code debt traded for lower
   Phase 4 risk (no "also delete a file" step mixed into the highest-risk phase)
   → Affirm / Reconsider (delete it in Phase 4 instead)
```

## Part 9: Multi-Epic Coordination

Not applicable — this epic is fully self-contained within the `auriga` repo and does
not depend on, or block, any other tracked epic.
