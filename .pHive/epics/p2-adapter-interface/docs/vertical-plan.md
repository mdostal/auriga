# Vertical Planning — Slice Plan: Adapter-Interface Extraction

**Input:** horizontal-plan.md + design-discussion.md (revised) + your resolved open questions

## 1. Slicing Strategy

```
STRATEGY:
  Total horizontal items: ~9-11 files across 7 layers
  Planned slices: 5
  First slice goal: prove "runs standalone" is real, cheaply, with zero risk to
    today's live behavior (no changes to auriga-router.mjs at all)
  Final slice goal: the pantheon-v2-l2 stub exists and the epic's "Done" bar from
    design-discussion §1 is fully met

  Slicing rationale: the two Multica-backed adapters (backlog, spawn) can each be
  built and unit-tested in complete isolation BEFORE touching the live router —
  that's the highest-value split, because it means the single highest-risk step
  (rewiring auriga-router.mjs's ~25 call sites) happens LAST, once both real
  adapters already exist and are proven correct against mocked CLI output. Building
  the stub adapters FIRST (slice 1) is also deliberate: it's the cheapest possible
  proof that the interface shape is right, before sinking effort into the harder
  Multica-backed implementations.
```

## 2. Vertical Slice Plan

```
## Slice 1: Interfaces + stub adapters prove "standalone" is real

WHAT WORKS AFTER THIS SLICE:
  A brand-new standalone smoke test runs cycle() end-to-end using ONLY in-memory
  stub adapters and passes, asserting zero execFileSync/process calls happen. This
  is the literal, testable proof of the epic's core claim — achieved before
  touching a single line of the live router.

LAYERS TOUCHED:
  Interfaces:
    - src/router/lib/adapters/backlog-adapter.mjs — JSDoc shape + doc comments
    - src/router/lib/adapters/spawn-adapter.mjs — JSDoc shape + doc comments
    - src/router/lib/adapters/README.md — two-adapter model explained
  Stub Adapters:
    - src/router/lib/adapters/stub/backlog.mjs — createStubBacklogAdapter(seedData?)
    - src/router/lib/adapters/stub/spawn.mjs — createStubSpawnAdapter()
  Tests:
    - src/router/test/stub-adapters.test.mjs
    - src/router/test/standalone-smoke.test.mjs

NOT YET:
  - Any Multica-backed adapter
  - Any change to auriga-router.mjs or lib/config.mjs
  - pantheon-v2-l2 stub

VERIFIED BY:
  - node:test: stub adapters satisfy the shape contract (every method callable,
    correct return shapes)
  - node:test: standalone-smoke.test.mjs drives cycle() with stub adapters only,
    asserts no execFileSync call is attempted (spy/mock on child_process)

COMMIT REPRESENTS: Adapter interfaces defined + standalone smoke test proves the
  core claim, with zero risk to live router behavior (nothing wired yet)

---

## Slice 2: Multica-backed backlog adapter, built and tested in isolation

BUILDS ON: Slice 1 (implements the same backlogAdapter shape)

WHAT WORKS AFTER THIS SLICE:
  createMulticaBacklogAdapter(cfg) exists, fully implements the backlogAdapter
  shape (issue CRUD/status/comment/PR-linkage including gh-backed PR discovery,
  per your Open Q1 resolution), and passes unit tests against mocked CLI output —
  but it is NOT yet wired into auriga-router.mjs. The live router is untouched and
  still running its current code path.

LAYERS TOUCHED:
  Multica-Backed Adapters:
    - src/router/lib/adapters/multica/backlog.mjs — ports lib/multica.mjs's
      issue CRUD + gh PR-discovery functions, informed by the mined status-mapping
      notes from src/engine/adapters/multica/ (research-brief §4)
  Config:
    - lib/config.mjs split begins: substrate config (AGENTS, PROJECT_NAMES,
      PROJECT_IDS) extracted to where the Multica backlog adapter can consume it
  Tests:
    - src/router/test/backlog-adapter.test.mjs — extends the existing
      mock-mca.mjs pattern

NOT YET:
  - Multica-backed spawn adapter
  - Any change to auriga-router.mjs (still running lib/multica.mjs directly)
  - Full config split (lane maps stay in lib/config.mjs until slice 3)

VERIFIED BY:
  - node:test: createMulticaBacklogAdapter's methods against mocked multica/gh CLI
    output, including the pagination and status-mapping edge cases documented in
    the research brief

COMMIT REPRESENTS: Multica-backed backlog adapter complete and tested in
  isolation — no live behavior change yet

---

## Slice 3: Multica-backed spawn adapter, built and tested in isolation

BUILDS ON: Slice 2 (independent of it functionally, but sequenced after so both
  real adapters land before the risky cutover in Slice 4)

WHAT WORKS AFTER THIS SLICE:
  createMulticaSpawnAdapter(cfg) exists, implements dispatch(issue, lane) and
  describeLanes() (static, adapter-owned config per Open Q2), wrapping today's
  assign/rerun/unassign logic — with explicitly NO provisioning method or hook of
  any kind (per your Vulcan decision). Passes unit tests. Still not wired into the
  live router.

LAYERS TOUCHED:
  Multica-Backed Adapters:
    - src/router/lib/adapters/multica/spawn.mjs
  Config:
    - lib/config.mjs split completes: PROJECT_LANE, DEFAULT_LANE, HIVE_LANE,
      REVIEW_LANE, RUNTIME_CAP move to substrate config; REVIEW_SQUAD_RULES, CAPS,
      HUMAN_NAMES stay in lib/config.mjs unchanged (policy)
  Tests:
    - src/router/test/spawn-adapter.test.mjs

NOT YET:
  - Any change to auriga-router.mjs's actual call sites

VERIFIED BY:
  - node:test: createMulticaSpawnAdapter's dispatch/describeLanes against mocked
    CLI output, confirming lane-map semantics are byte-identical to today's
    PROJECT_LANE/DEFAULT_LANE/HIVE_LANE/REVIEW_LANE behavior (including the known
    "7 unmapped project names" gap carried forward unchanged, per VISION.md)

COMMIT REPRESENTS: Multica-backed spawn adapter complete and tested in isolation
  — both real adapters now exist, ready for cutover

---

## Slice 4: Router wiring cutover — the actual behavior-preservation proof

BUILDS ON: Slices 1-3 (needs both real adapters to exist and be trustworthy)

WHAT WORKS AFTER THIS SLICE:
  auriga-router.mjs's cycle() now takes backlog + spawn as its injectable
  dependencies (replacing mca), defaulting to the Multica-backed adapters from
  slices 2-3 in main(). All ~25 mcaImpl.* call sites across the unblock, cascade,
  false-done/review-scan, dispatch, and review-lane passes are re-pointed to
  backlog.*/spawn.* methods. This is the actual cutover — after this slice, the
  live supervised router is running through the new adapter boundary.

LAYERS TOUCHED:
  Router Wiring:
    - src/router/auriga-router.mjs — cycle() signature + all call sites
  Tests:
    - ALL 6 existing test files (core, cascade, descdeps, slugkey, squad,
      router-cycle.e2e) re-run and confirmed green — this is the acceptance bar
      for the entire epic, not just this slice

NOT YET:
  - pantheon-v2-l2 stub adapter

VERIFIED BY:
  - The full existing test suite (26+ assertions across 6 files) passing
    unchanged — proves behavior preservation
  - Manual: one dry-run cycle (`npm run dry`) against a real (or recently-mocked)
    Multica workspace, comparing logged decisions before/after this slice for a
    spot-check (not a new automated test — a one-time sanity check before merge)

COMMIT REPRESENTS: The adapter cutover is live — Auriga's live router now runs on
  the new adapter boundary with zero behavior change, proven by the full existing
  regression suite

---

## Slice 5: pantheon-v2-l2 stub + docs — epic's "Done" bar fully met

BUILDS ON: Slice 1 (interfaces) — functionally independent of Slices 2-4, sequenced
  last for narrative closure (see Moldability Notes — this could move earlier)

WHAT WORKS AFTER THIS SLICE:
  The pantheon-v2-l2 adapter directory exists as a documented, clearly
  not-yet-implemented stub implementing both shapes. .pHive/CONTEXT.md gets the new
  adapter vocabulary (backlogAdapter, spawnAdapter, pantheon-v2-l2) added. Every
  criterion in design-discussion.md §1 "Done" is now met.

LAYERS TOUCHED:
  Pantheon L2 Stub Adapter:
    - src/router/lib/adapters/pantheon-v2-l2/index.mjs
    - src/router/lib/adapters/pantheon-v2-l2/README.md
  Docs:
    - .pHive/CONTEXT.md — add backlogAdapter/spawnAdapter/pantheon-v2-l2 terms
    - README.md / VISION.md — note the adapter interface has landed (§① update)

NOT YET (deferred beyond this epic — see Deferred Items below):
  - A real pantheon-v2-l2 implementation
  - The queue UI
  - vcsAdapter split, dynamic lane discovery, vulcan-hook.mjs disposition

VERIFIED BY:
  - node:test: pantheon-v2-l2 stub's methods all throw/return the documented
    not-yet-implemented shape (proves it's inert, not silently half-working)

COMMIT REPRESENTS: Epic complete — adapter interfaces, two working implementations
  (Multica-backed live, stub for standalone), and a documented Pantheon stub, with
  zero direct external-system coupling anywhere in Auriga's core
```

## 3. Overlay Diagram

```
VERTICAL SLICE OVERLAY
─────────────────────────────────────────────────────────────────────────────

              │ Slice 1     │ Slice 2      │ Slice 3      │ Slice 4      │ Slice 5    │
              │ (Interfaces │ (Multica     │ (Multica     │ (Cutover)    │ (Pantheon  │
              │  + stubs)   │  backlog)    │  spawn)      │              │  L2 + docs)│
──────────────┼─────────────┼──────────────┼──────────────┼──────────────┼────────────┤
Interfaces    │ both shapes │              │              │              │            │
              │ defined     │              │              │              │            │
──────────────┼─────────────┼──────────────┼──────────────┼──────────────┼────────────┤
Multica       │             │ backlog      │ spawn        │              │            │
Adapters      │             │ adapter      │ adapter      │              │            │
──────────────┼─────────────┼──────────────┼──────────────┼──────────────┼────────────┤
Stub Adapters │ both built  │              │              │              │            │
──────────────┼─────────────┼──────────────┼──────────────┼──────────────┼────────────┤
Pantheon L2   │             │              │              │              │ stub built │
──────────────┼─────────────┼──────────────┼──────────────┼──────────────┼────────────┤
Config        │             │ substrate    │ substrate    │              │            │
              │             │ split begins │ split done   │              │            │
──────────────┼─────────────┼──────────────┼──────────────┼──────────────┼────────────┤
Router Wiring │             │              │              │ full cutover │            │
              │             │              │              │ (25 sites)   │            │
──────────────┼─────────────┼──────────────┼──────────────┼──────────────┼────────────┤
Tests         │ stub +      │ backlog      │ spawn        │ ALL 6        │ pantheon-l2│
              │ smoke tests │ adapter test │ adapter test │ existing     │ stub test  │
              │             │              │              │ green        │            │
─────────────────────────────────────────────────────────────────────────────

Each column is a commit-worthy, working state. Slice 4 is the only one that
touches the live router's actual behavior — every other slice is purely additive.
```

## 4. Deferred Items

```
DEFERRED (not in this slice plan):
  - vcsAdapter split — Open Q1 resolved as "keep PR-discovery inside
    backlogAdapter for this epic," revisit only if a second VCS is ever needed
  - Dynamic lane/agent discovery — VISION.md §② names this as a separate near-term
    goal, not this epic (Open Q2 resolution)
  - Real pantheon-v2-l2 implementation — stays a documented stub per the epic's
    explicit brief; building the real integration is Pantheon's future epic
  - Queue UI — separate, later epic (your explicit confirmation); future shape
    recorded in VISION.md §④
  - lib/vulcan-hook.mjs disposition (leave dormant vs. delete) — small open
    follow-up from Open Q3's resolution, not blocking, can be a fast-follow story
    or handled ad hoc outside this epic

RATIONALE: each of these is either explicitly out of scope per your review, or a
separately-scoped future goal already named in VISION.md — none of them are
prerequisites for this epic's "Done" bar (design-discussion.md §1).
```

## 5. Risk by Slice

```
RISK PER SLICE:
  Slice 1: Low — entirely new code path, zero interaction with the live router.
  Slice 2: Low-medium — must correctly preserve the empirically-documented
    Multica pagination and status-mapping semantics; mocked-CLI tests catch
    regressions before they'd ever reach production.
  Slice 3: Low-medium — must preserve exact PROJECT_LANE/DEFAULT_LANE/HIVE_LANE/
    REVIEW_LANE semantics including the known 7-unmapped-names gap; same
    mocked-test safety net.
  Slice 4: High — this is the actual behavior-preservation proof; 25 call sites
    across 5 distinct passes in the live router. This is where a subtle mistake
    would actually reach the supervised production process. Mitigation: the full
    existing 6-file regression suite must pass unchanged before this slice is
    considered done, plus a manual dry-run spot-check.
  Slice 5: Low — pure addition (a new, inert stub directory), no interaction with
    the live path.
```

## 6. Moldability Notes

- **Slice 5 (pantheon-v2-l2) only depends on Slice 1**, not Slices 2-4 — it could
  be pulled earlier and run in parallel with Slices 2-3 if a contributor wants to
  parallelize. Kept last here for narrative clarity (closes the epic's "Done" bar
  cleanly), not because of a hard dependency.
- **Slices 2 and 3 are independent of each other** (backlog adapter vs. spawn
  adapter) — order between them can flip with no impact on the plan.
- **Slice 4 cannot move earlier** — it strictly needs both Slice 2 and Slice 3
  complete, since main()'s default construction needs both real adapters.
- **If scope needs to shrink**, Slice 5 is the safest to defer past this epic
  entirely (the "Done" bar in design-discussion.md would need re-confirming with
  you first) — Slices 1-4 alone already deliver the core standalone + Multica-
  preserving-behavior claim.
- **What might expand the plan:** if Slice 4's manual dry-run spot-check surfaces
  a real behavior difference, that becomes a new fix-forward story inserted before
  Slice 4 is considered complete — not a reason to abandon the slice boundary.
