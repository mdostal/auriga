# Horizontal Planning Scan: Adapter-Interface Extraction

**Input:** design-discussion.md (revised, all 6 open questions resolved) + research-brief.md

## 1. Layer Inventory

This epic touches exactly one module (`src/router/`) — there is no frontend/data-layer
split in the traditional sense. The "layers" here are the boundaries between the
router's pure decision core (unchanged) and its I/O surface (the actual work):

- **Adapter interfaces** — the new shape contracts (`backlogAdapter`, `spawnAdapter`)
  that everything else implements or consumes. Doesn't exist today.
- **Multica-backed adapter implementations** — today's real behavior, refactored to
  implement the new shapes. Exists today as `lib/multica.mjs`, gets restructured.
- **Stub adapter implementations** — new. In-memory, zero external calls. What makes
  "runs standalone" literally true.
- **pantheon-v2-l2 stub adapter** — new. Documented not-yet-implemented, satisfies
  "no direct Pantheon coupling" without building the real integration.
- **Config** — `lib/config.mjs`, splits into substrate config (adapter-owned) vs.
  policy config (`REVIEW_SQUAD_RULES`, `CAPS`, `HUMAN_NAMES` — untouched).
- **Router wiring** — `auriga-router.mjs`'s `cycle()` options bag and its ~25
  `mcaImpl.*` call sites, rewired to depend on the adapter shapes instead of the
  Multica module directly.
- **Test suite** — the 6 existing files (regression baseline) plus new adapter/
  interface-contract tests and a standalone smoke test.
- **`lib/vulcan-hook.mjs`** — explicitly OUT of scope, untouched, left as dormant
  legacy code (per your Vulcan decision — no provisioning concept anywhere in core).

## 2. Per-Layer Requirements

```
## Layer: Adapter Interfaces

SHAPES NEEDED:
  - backlogAdapter — listIssues(projectId), listAllProjectIds(), getIssueRuns(id),
    getIssuePullRequests(id) [includes gh-backed PR discovery per Open Q1], assignIssue(id, agent),
    rerunIssue(id), unassignIssue(id), setIssueStatus(id, status), commentOnIssue(id, body)
  - spawnAdapter — dispatch(issue, lane), describeLanes() [static config for this
    epic, per Open Q2]. NO provisioning method/hook of any kind (per your decision).

DOCUMENTATION:
  - JSDoc typedef blocks for both shapes (no TS build step)
  - A short README in src/router/lib/adapters/ explaining the two-adapter model,
    cross-referencing .pHive/CONTEXT.md and the adapter-boundary-integrity concern

---

## Layer: Multica-Backed Adapter Implementations

FUNCTIONS TO PORT (from lib/multica.mjs, behavior-preserving):
  - createMulticaBacklogAdapter(cfg) → object implementing backlogAdapter, wrapping
    listIssues/listAllProjectIds/listAllIssues/issueRuns/assignIssue/rerunIssue/
    issueStatus/issuePullRequests/unassignIssue/issueComment AND the gh-backed
    ghOpenPrs/ghListRepos/ghPrs (folded in per Open Q1 resolution)
  - createMulticaSpawnAdapter(cfg) → object implementing spawnAdapter, wrapping the
    assign/rerun-as-dispatch behavior + describeLanes() reading PROJECT_LANE/
    DEFAULT_LANE/HIVE_LANE/REVIEW_LANE (moved from config.mjs into adapter-owned data)

STATUS-MAPPING NOTES TO CARRY FORWARD:
  - Mine src/engine/adapters/multica/index.ts's empirical status-enum mapping
    comments (todo|in_progress|in_review|done|blocked|backlog|cancelled) and the
    PUT-is-partial-merge / no-CAS / no-native-lease findings — genuine prior art,
    cite as code comments in the new implementation, don't silently drop them

---

## Layer: Stub Adapter Implementations

FUNCTIONS NEEDED:
  - createStubBacklogAdapter(seedData?) → in-memory object implementing
    backlogAdapter, zero execFileSync/process calls, seedable for tests
  - createStubSpawnAdapter() → in-memory object implementing spawnAdapter, records
    dispatch calls for test assertions instead of doing anything external

---

## Layer: pantheon-v2-l2 Stub Adapter

FILES NEEDED:
  - src/router/lib/adapters/pantheon-v2-l2/index.mjs — implements both shapes as
    clear not-yet-implemented stubs (throws a NotImplementedError-shaped error)
  - src/router/lib/adapters/pantheon-v2-l2/README.md — states this is the ONLY
    sanctioned path from Auriga to Pantheon, and that it is intentionally unbuilt

---

## Layer: Config

SPLIT NEEDED:
  - Substrate config (moves out of lib/config.mjs into adapter constructor args or
    a new lib/config-substrate.mjs consumed only by the Multica adapters):
    AGENTS, PROJECT_NAMES, PROJECT_IDS, PROJECT_LANE, DEFAULT_LANE, HIVE_LANE,
    REVIEW_LANE, REVIEW_REPO_OWNER, REVIEW_SEARCH_REPOS, RUNTIME_CAP
  - Stays in lib/config.mjs unchanged (policy, substrate-agnostic):
    REVIEW_SQUAD_RULES, CAPS, HUMAN_NAMES
  - The "17 UUIDs, 13 unaligned, 7-unmapped-names known gap" must carry forward
    byte-identical into the substrate config — not fixed, not dropped (explicitly
    out of scope per VISION.md)

---

## Layer: Router Wiring

CHANGES NEEDED:
  - cycle()'s options bag: mca → backlog + spawn (two injectables, per Open Q1
    resolution — no third vcs injectable)
  - All ~25 mcaImpl.* call sites in auriga-router.mjs (unblock pass, cascade pass,
    false-done/review-scan pass, dispatch pass, review lane) re-pointed to
    backlog.* or spawn.* methods
  - main()'s default construction: backlog = createMulticaBacklogAdapter(substrateConfig),
    spawn = createMulticaSpawnAdapter(substrateConfig) — preserves today's live
    behavior with zero config changes for the existing supervised deployment

---

## Layer: Test Suite

NEW TEST FILES (flat under src/router/test/, per Open Q1/C1 resolution):
  - backlog-adapter.test.mjs — multica-backed backlog adapter against mocked CLI
    output (extends existing mock-mca.mjs pattern)
  - spawn-adapter.test.mjs — multica-backed spawn adapter, same pattern
  - stub-adapters.test.mjs — stub adapters satisfy the same interface contract
  - standalone-smoke.test.mjs — cycle() run end-to-end against ONLY stub adapters,
    asserts zero execFileSync calls attempted

EXISTING (regression baseline, must stay green throughout):
  core.test.mjs, cascade.test.mjs, descdeps.test.mjs, slugkey.test.mjs,
  squad.test.mjs, router-cycle.e2e.test.mjs
```

## 3. Cross-Layer Dependencies

```
DEPENDENCIES:

Multica-Backed Adapters → Adapter Interfaces (must implement the defined shapes)
Multica-Backed Adapters → Config (need substrate config: AGENTS, PROJECT_IDS, lane maps)
Stub Adapters → Adapter Interfaces (must implement the SAME shapes — this is what
  makes them swappable with the Multica-backed ones)
pantheon-v2-l2 Stub Adapter → Adapter Interfaces (implements the shapes as stubs)
Router Wiring → Adapter Interfaces (cycle()'s options bag is typed against the shapes)
Router Wiring → Multica-Backed Adapters (main()'s default construction needs a real
  implementation to preserve live behavior)
Test Suite (new) → all adapter layers (nothing to test until they exist)
Test Suite (existing, regression) → Router Wiring (must stay green as wiring changes)
Standalone Smoke Test → Stub Adapters + Router Wiring (proves standalone claim)
```

The key ordering constraint: **Adapter Interfaces must exist before anything else can
be written against them**, and **Router Wiring must happen last** (after both Multica
and stub adapters exist) because it's the integration point where behavior-preservation
risk concentrates.

## 4. Layer Map Diagram

```
HORIZONTAL LAYER MAP
─────────────────────────────────────────────────────────────────────

Interfaces   │ backlogAdapter shape        │ spawnAdapter shape          │
             │ (JSDoc typedef, no PR split)│ (JSDoc typedef, no provision)│
─────────────┼──────────────────────────────┼──────────────────────────────┤
Multica      │ createMulticaBacklogAdapter  │ createMulticaSpawnAdapter    │
Adapters     │ (issue CRUD + gh PR discovery)│ (dispatch + static lanes)   │
─────────────┼──────────────────────────────┼──────────────────────────────┤
Stub         │ createStubBacklogAdapter     │ createStubSpawnAdapter       │
Adapters     │ (in-memory, seedable)        │ (in-memory, records calls)   │
─────────────┼──────────────────────────────┼──────────────────────────────┤
Pantheon L2  │ pantheon-v2-l2/index.mjs (both shapes, documented stub)     │
─────────────┼──────────────────────────────────────────────────────────────┤
Config       │ substrate config (AGENTS,    │ policy config (unchanged:    │
             │ PROJECT_IDS, lane maps)      │ REVIEW_SQUAD_RULES, CAPS,    │
             │ moved to adapter-owned       │ HUMAN_NAMES)                 │
─────────────┼──────────────────────────────┼──────────────────────────────┤
Router       │ cycle() options bag: mca →   │ ~25 mcaImpl.* call sites     │
Wiring       │ backlog + spawn              │ re-pointed                   │
─────────────┼──────────────────────────────────────────────────────────────┤
Tests        │ 4 new files (flat, src/router/test/) + 6 existing (regression)│
─────────────────────────────────────────────────────────────────────
```

## 5. Scope Summary

```
HORIZONTAL SCOPE:
  Layers affected: 7 (interfaces, multica adapters, stub adapters, pantheon-v2-l2,
    config, router wiring, tests)
  Total items: ~9-11 files (2 interface files, 2 multica adapter files, 2 stub
    adapter files, 2 pantheon-v2-l2 files, 1 config split, 1 router-wiring change,
    4 new test files — router wiring is a change to an existing file, not new)
  New vs modified: ~9 new files, 2 modified (auriga-router.mjs, lib/config.mjs)
  Estimated total effort: large (foundational interface + behavior-preserving
    refactor across the entire I/O surface of the router)

  LARGEST LAYER: Router Wiring (25 call sites across 5 distinct passes — unblock,
    cascade, false-done/review-scan, dispatch, review lane)
  RISKIEST LAYER: Router Wiring — this is where "behavior-preserving" is proven or
    broken; every existing test must stay green through this layer's changes
```
