# Design Discussion: Adapter-Interface Extraction

## 1. What Are We Doing?

Right now Auriga only works inside one specific Multica workspace, with 9 agent UUIDs
and 17 project UUIDs hand-typed into `src/router/lib/config.mjs`. If you deleted that
workspace, Auriga would not run — there's no path where it operates standalone. The
brief for this epic is: give Auriga a generic adapter boundary — a **backlog adapter**
(where do tasks come from, how do we read/write their state) and a **persona/spawn
adapter** (who can do the work, how do we hand it off) — so any consumer plugs in their
own backend. Multica becomes one implementation of that interface, not the only way
Auriga can run. A stub **pantheon-v2 L2 adapter** proves the shape works for Pantheon
specifically, without Auriga ever importing Minerva, Consus, or Pantheon code directly.

"Done" for *this* epic is: the interfaces exist, are documented, have a working
in-memory/stub implementation that needs zero external services, and the existing
Multica-backed behavior is refactored to implement those interfaces losslessly (same
routing decisions, same tests passing) — NOT a rewrite of the routing logic itself.

**Scope-cut called out explicitly (grill finding P1):** I'm proposing to defer the
queue UI to a separate, later epic. North_star's `goal`/`success` fields actually
bundle "runs standalone with its own queue **and UI**" as ONE success condition, not
a phased one — so this split is a scope decision *I'm making in this document*, not
something north_star already settled. My reasoning: the adapter interface is a
prerequisite for a UI that needs something adapter-shaped to talk to (a UI can't
render a queue that has no standalone-capable backend yet), and bundling both into
one epic would make this already-foundational, architecture-defining work even
larger. See Open Question 5 — flag if you'd rather keep UI in scope here.

## 2. What I Found

- **The hard part is already done.** `lib/core.mjs` (1,127 lines) is pure — it takes
  plain issue/run/PR-shaped objects plus a config object and returns decisions. It
  never imports `multica.mjs` or shells out to anything. `isHiveStory`,
  `selectAssignments`, `detectRunCompletions`, `detectVerifiedDone`, `reviewSquadPlan`
  are all substrate-agnostic today. This means the adapter work is about generalizing
  I/O, not rewriting decision logic.
- **There isn't one hardcoded coupling, there are three.** `lib/multica.mjs` wraps the
  `multica` CLI (issue CRUD/status/comment/PR-linkage) AND separately shells to `gh`
  (`ghOpenPrs`, `ghListRepos`, `ghPrs`) because "Multica's issue<->PR linkage is empty
  in practice" (the file's own comment). `lib/vulcan-hook.mjs` shells to a
  hardcoded-path `vulcan` binary for repo provisioning — currently written but "not yet
  wired" into the dispatch loop per its own header.
- **`config.mjs` conflates substrate facts with policy.** Real Multica UUIDs
  (`AGENTS`, `PROJECT_NAMES`, `PROJECT_IDS`, lane maps) sit in the same file as
  substrate-agnostic policy (`REVIEW_SQUAD_RULES` keyword→tier map, `CAPS` batch
  numbers, `HUMAN_NAMES`). Only the first group needs to move behind an adapter; the
  second group is fine staying as project-level config.
- **There's already a test-time adapter shape.** `test/support/mock-mca.mjs` +
  `test/router-cycle.e2e.test.mjs` inject a mock object matching a subset of
  `multica.mjs`'s surface into `cycle()`'s options bag and get a working loop-level
  e2e test with zero live Multica. A formal interface mostly needs to name and freeze
  what this mock already informally implements.
- **The old `src/engine/` TypeScript code (commit `f4847ee`, on `dev`/`feat/PAN-8245`,
  not on a real `feat/routing-engine` branch — VISION.md's reference is stale) is NOT
  a usable adapter interface.** Every file in it imports from a `contracts/` directory
  that was never actually recovered — it doesn't exist anywhere in git history. So
  `src/engine/` is 51 files of *implementation* for an interface that's gone. What IS
  worth mining: `MulticaTrackerAdapter`'s empirical comments about Multica's real
  status-enum mapping and its "PUT is a partial merge, no CAS, no native lease"
  findings — genuine prior art, not guesses. The escalation/observability/verifier-pool
  machinery in there is out of scope (a different, P1/P2-era orchestration epic) and
  should NOT be ported.
- **`node:test`, ESM, zero deps, no TypeScript in the live path.** `src/router/` is
  plain `.mjs`. Any new adapter code should stay in that world — introducing
  TypeScript/build tooling for this epic is scope creep the research didn't ask for.

## 3. My Proposed Approach

1. **Define interfaces as plain JS "shape contracts"** (documented JSDoc typedefs, not
   a TS build step, and NOT ES6 classes — this codebase has zero `class` declarations
   anywhere and a stated camelCase/plain-function/plain-object convention; grill
   finding C2 caught my first draft naming these like classes). Adapter
   *implementations* are plain modules exporting a frozen object literal of camelCase
   functions (a factory function like `createMulticaBacklogAdapter(cfg)` returning
   that object), not `new SomeAdapter()`. Location: **`src/router/lib/adapters/`**,
   not a top-level `src/adapters/` — this stays inside the one module the CI gate
   actually knows about (grill finding C1: root `package.json`'s test script is a
   non-recursive glob scoped to `src/router/test/*.test.mjs`, so anything outside
   `src/router/` risks silently never running in CI).
   - `backlogAdapter` shape — `listIssues(projectId)`, `listAllProjectIds()`,
     `getIssueRuns(id)`, `getIssuePullRequests(id)`, `assignIssue(id, agent)`,
     `rerunIssue(id)`, `unassignIssue(id)`, `setIssueStatus(id, status)`,
     `commentOnIssue(id, body)`. This is `lib/multica.mjs`'s Multica-only surface,
     renamed to substrate-neutral verbs.
   - **Whether `gh`/PR-discovery (`ghOpenPrs`, `ghListRepos`, `ghPrs`) is part of this
     shape, or a separate `vcsAdapter` shape, is NOT decided — it's Open Question 1.**
     I raised it as a proposal in my first draft but grill (finding V1) correctly
     caught that I was using the `vcsAdapter` name confidently elsewhere as if it
     were settled, when neither `north_star` nor `CONTEXT.md` know about a third
     adapter kind (they define exactly two: backlog + persona/spawn). I've walked
     that back below — everywhere I mention PR-discovery routing now says "part of
     `backlogAdapter`, or a separate `vcsAdapter` — pending Open Question 1."
   - `spawnAdapter` shape — `dispatch(issue, lane)` (replaces the assign/rerun-as-
     dispatch conflation), `describeLanes()` (replaces the hardcoded `PROJECT_LANE`/
     `DEFAULT_LANE`/`HIVE_LANE`/`REVIEW_LANE` maps as adapter-owned data instead of
     router-owned constants). **`spawnAdapter` has NO provisioning method, hook, or
     middleware slot of any kind (Open Question 3 — resolved by you: no direct
     Vulcan hook, no generic "provisioning" concept in Auriga's core at all).** Your
     framing: if a specific consumer (Pantheon) needs repo provisioning, that's
     Pantheon's concern — handled by a runner Auriga is merely aware of, or by
     Pantheon's own "create" command, decided when that specific `spawnAdapter`
     implementation is built, not designed into Auriga pre-emptively. This is the
     same `adapter-boundary-integrity` principle already in
     `.pHive/cross-cutting-concerns.yaml`, now explicitly extended to provisioning:
     Auriga's core interfaces stay ignorant of Vulcan (or any specific provisioning
     tool) by name, forever — not just for this epic.
2. **Implement the Multica-backed adapters** wrapping today's `lib/multica.mjs` logic
   verbatim (behavior-preserving refactor, not a rewrite) — informed by the mined
   status-mapping notes from `src/engine/adapters/multica/` (see research brief §4).
3. **Implement stub adapters** — in-memory, zero external process calls, used by a new
   standalone-mode smoke test and by anyone running Auriga outside Pantheon with no
   Multica account at all. This is what makes "runs fully standalone" true and
   testable, not just aspirational.
4. **Add a `pantheon-v2-l2` adapter directory that is a documented stub** —
   `src/router/lib/adapters/pantheon-v2-l2/` with the interface implemented as clear
   not-yet-implemented stubs (throwing a `NotImplementedError`-shaped error or
   returning empty results, per whatever the team prefers) plus a README stating this
   is the ONLY sanctioned path from Auriga to Pantheon and it is intentionally unbuilt
   in this epic. This satisfies "no direct Minerva/Consus/Pantheon coupling" without
   scope-creeping into actually building the Pantheon integration here.
5. **Split `lib/config.mjs`** into substrate config (moves to adapter-owned
   config/constructor args — `AGENTS`, `PROJECT_IDS`, lane maps) vs. policy config
   (`REVIEW_SQUAD_RULES`, `CAPS`, `HUMAN_NAMES` stay in `lib/config.mjs`, unchanged).
6. **Rewire `cycle()`'s options bag.** If Open Question 1 resolves to "PR-discovery
   stays inside `backlogAdapter`," `mca` becomes exactly two injectables — `backlog` +
   `spawn` — and this is a signature change, not an architecture change (the seam
   already exists). **If Open Question 1 resolves to a separate `vcsAdapter`, this
   becomes a three-way triage instead** (grill finding U2): all 25 `mcaImpl.*` call
   sites across the unblock, cascade, false-done/review-scan, and dispatch passes in
   `auriga-router.mjs` (not just the review lane — see the corrected risk in §4) need
   sorting into `backlog`/`spawn`/`vcs`, which is more surface area than the two-way
   split and may shift the scale assessment. I'm not resolving this now — it depends
   on Open Question 1.
7. **Re-run the full existing test suite (26+ tests across 6 files) against the
   refactored code**, plus new tests for the stub adapters and interface contracts —
   **placed flat inside `src/router/test/`** (matching the existing non-recursive
   glob `src/router/test/*.test.mjs`, e.g. `src/router/test/backlog-adapter.test.mjs`)
   so they're actually discovered by `npm test` / CI, not nested under a
   `test/adapters/` subdirectory the current glob wouldn't reach (grill finding C1).
   The acceptance bar: the Multica-backed behavior is provably unchanged, verified by
   the existing suite passing, plus the new adapter tests passing.

## 4. What Could Go Wrong

- **Medium — scope temptation to also build the real Pantheon-v2 L2 integration.** The
  brief is explicit that this stays a stub. The risk is a future story quietly turning
  "documented stub" into "half-built integration," which reintroduces the direct-
  coupling problem this epic exists to prevent. Mitigation: the
  `adapter-boundary-integrity` cross-cutting concern (already in
  `.pHive/cross-cutting-concerns.yaml`) gates every story on this.
- **Medium-to-high (corrected from "medium" per grill finding H1) — the `gh` vs.
  Multica split (`vcsAdapter` vs `backlogAdapter`) is a design call, not a discovered
  fact, AND its blast radius is bigger than I first scoped.** Today's code treats PR
  lookup as part of "the Multica layer" purely because it lives in the same file, not
  because it's conceptually Multica. I originally described the fallback as "the
  `REVIEW_LANE` code needs a different interface home" — that undersold it.
  `gh`-backed PR discovery (`ghPrs`/`ghOpenPrs`/`ghListRepos`) actually gates THREE
  state-machine passes in `auriga-router.mjs`, not just review dispatch: the
  blocked→todo unblock pass, the cascade re-dispatch pass, and the false-done/
  review-scan pass, in addition to the review lane itself. Getting Open Question 1's
  answer wrong or changing it mid-epic touches more of the router than "review" implies.
- **Resolved — `lib/vulcan-hook.mjs` stays entirely out of this epic's scope**, per
  your explicit steer: Auriga's core `spawnAdapter` interface must never know about
  Vulcan (or any specific provisioning tool) by name. It's currently unused/unwired
  (never called from `auriga-router.mjs`'s dispatch loop), so leaving it untouched has
  zero behavior-preservation risk. It stays on disk as dormant legacy code unless you'd
  rather I remove it outright in a story — flagging that as a small open item, not
  blocking (see Open Question 3, now resolved with a follow-up note).
- **Low — the "17 hardcoded project UUIDs, 13 unaligned" reality means the
  `MulticaBacklogAdapter`'s config needs to carry forward the exact same
  `PROJECT_IDS`/`PROJECT_NAMES` gap** (including the known-gap comment about 7 unmapped
  project names) rather than silently dropping or "fixing" it as part of this refactor
  — that's explicitly out of scope per VISION.md ("Needs reconciliation with
  Minerva/operator before this part of the epic can be completed").
- **Low — no TypeScript/build step exists today; introducing one for "proper"
  interfaces would be scope creep.** Sticking to JSDoc typedefs + `node:test` assertion
  checks keeps this a behavior-preserving refactor, not a tooling migration.

## 5. Dependencies and Constraints

- No external dependency additions — stays zero-runtime-deps Node/ESM per current
  convention (`hive.config.yaml` / `.pHive/CONTEXT.md` convention note).
- Depends on nothing from other Pantheon repos — by design, this epic produces no new
  outbound calls to Minerva/Consus/Pantheon; the pantheon-v2 L2 adapter stays a stub.
- Constrained by the existing test suite as the regression baseline — the 6 existing
  test files must stay green throughout, not just at the end.
- `hive.config.yaml -> developer.pr_style: atomic-prs` — real merge commits, not
  squash, per your explicit preference from kickoff.

## 6. Open Questions

1. **Is GitHub PR-lookup (`ghOpenPrs`/`ghListRepos`/`ghPrs`) part of the
   `backlogAdapter` shape, or a separate `vcsAdapter` shape?** This is the biggest
   swing-question in the whole design — it decides whether `north_star`/`CONTEXT.md`'s
   two-adapter model needs a documented third kind (grill finding V1), whether the
   `cycle()` options-bag rewire is a two-way or three-way split (finding U2), and it
   touches THREE state-machine passes beyond the review lane, not just the review lane
   (finding H1, corrected in §4). Given the real blast radius, my lean has shifted
   toward keeping PR-discovery inside `backlogAdapter` for this epic (simpler, smaller
   diff, avoids an undocumented third adapter kind) and revisiting a `vcsAdapter` split
   later if a second VCS (not GitHub) is ever needed — but I want your call before I
   commit to either in the structured outline.
2. Should `spawnAdapter.describeLanes()` be static config (like today) or a live query
   (agents/lanes discovered dynamically)? VISION.md's §② goals call out "dynamic
   lane/agent discovery" as a near-term goal but a SEPARATE one from this epic — I'm
   assuming static-but-adapter-owned config for this epic, dynamic discovery later.
   Confirm that's the right scope cut.
3. **RESOLVED (your answer):** No hook, method, or middleware for provisioning
   anywhere in Auriga's core. `spawnAdapter` does not know Vulcan exists. Provisioning
   is entirely a specific consumer implementation's concern (e.g. Pantheon's own
   runner/create-command), discovered and built when that specific integration is
   built — never pre-emptively designed into Auriga. Follow-up (not blocking): should
   `lib/vulcan-hook.mjs` be deleted in this epic since it's now confirmed out-of-scope
   dead code, or left dormant for a separate cleanup pass?
4. Naming: `pantheon-v2-l2` as the stub adapter directory name, or is there an existing
   naming convention from Pantheon-side work I should match?
5. **RESOLVED (your answer): deferred to a later epic, confirmed.** You also gave the
   future shape of that UI (v0-style, LLM-in-browser, shadcn/ui-based, self-building
   with templates) — recorded in `VISION.md §④` and in cross-session memory so it
   surfaces when that epic is eventually planned. Not actionable in p2.
6. Are the adapter *implementations* meant to be plain factory-function modules (my
   revised proposal, matching this codebase's zero-class convention — grill finding
   C2) or is there an appetite for introducing a class-based pattern here? I'm
   assuming plain functions/objects unless you say otherwise.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: node:test (existing convention, no new framework)
  Platforms: N/A (headless Node service, no browser/mobile surface)
  Automated:
    - All 6 existing test files (core, cascade, descdeps, slugkey, squad,
      router-cycle.e2e) re-run green against the refactored adapters — proves
      behavior preservation.
    - New unit tests for MulticaBacklogAdapter / MulticaSpawnAdapter against
      mocked CLI output (extending the existing mock-mca.mjs pattern).
    - New unit tests for StubBacklogAdapter / StubSpawnAdapter proving they
      satisfy the same interface contract with zero external calls.
    - New "standalone smoke test" — cycle() run end-to-end against ONLY the
      stub adapters, asserting it completes without attempting any
      execFileSync call (this is the literal test of "runs standalone").
  Manual: none planned — this is backend refactor work with full test coverage
    achievable through node:test.
  Not verifying: the pantheon-v2 L2 adapter's real behavior (it's a stub with
    no real behavior yet) and the queue UI (separate future epic).
```

## 8. Scale Assessment

**Size indicators:**
- Files affected: ~7-9 (new `src/router/lib/adapters/{backlog,spawn,pantheon-v2-l2}/`
  + interface definitions, refactored `lib/multica.mjs`, `lib/config.mjs` split,
  `auriga-router.mjs` call-site changes, new test files — `lib/vulcan-hook.mjs` is now
  OUT of scope entirely, left untouched, per your no-provisioning-hook decision).
- Subsystems: router core (`lib/core.mjs` untouched), I/O layer (`lib/multica.mjs` —
  restructured; `lib/vulcan-hook.mjs` untouched/out of scope), config (`lib/config.mjs`
  — split), test suite (extended).
- Migration required: no data migration; this is a code-structure refactor with a
  behavior-preservation bar.
- Cross-team coordination: none — single repo, single contributor per kickoff context.
- Unknowns: 6 open questions above (up from 4 after the grill pass surfaced two more
  — Q5 UI scope, Q6 class-vs-function naming), none of which block starting work but
  Q1 in particular (backlog-vs-vcs split) materially changes the file manifest and
  should be resolved before the structured outline locks the story boundaries.

```
SCALE ASSESSMENT:
  Files affected: ~8-10 (up to ~12 if Open Question 1 resolves to a separate vcsAdapter)
  Subsystems: router I/O layer, config, test suite (core decision logic untouched)
  Migration required: no
  Cross-team coordination: no
  Unknowns: 6 (interface boundary questions, all answerable, none blocking; Q1 affects scope size)

  RECOMMENDATION: Needs structured outline
  RATIONALE: This is architecture-defining work (new interface boundary that
  every future story touching dispatch/backlog will build against) with a
  multi-file manifest and real design decisions (adapter split, config split)
  that benefit from explicit sequencing and a risk registry before
  decomposing into stories. It's not large in raw file count, but it's
  foundational — getting the interface shape wrong here compounds. Proceeding
  with H/V planning + a structured outline (Large-scope path) rather than
  jumping straight to stories from this document alone.
```
