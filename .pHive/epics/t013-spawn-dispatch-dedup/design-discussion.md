# t013: spawn-dispatch dedup

## Problem

`src/router/lib/adapters/multica/spawn.mjs` and
`src/router/lib/adapters/pantheon-v2-l2/index.mjs` each carry a
byte-identical private copy of `dispatch()` (assign -> sleep verifyDelayMs
-> check for a started run -> force-rerun if none started) and
`describeLanes()` (assembles the LaneMap from PROJECT_LANE/DEFAULT_LANE/
HIVE_LANE/REVIEW_LANE/RUNTIME_CAP). Confirmed by direct side-by-side read of
both function bodies (2026-09-06) — identical modulo the injected
`getIssueRuns`/`getIssueRunsForVerify` name difference.

This is the same class of drift risk already found and fixed twice this
week:
- t008 (github-cli.mjs): `ghRun`/`ghListRepos`/`ghPrs` hand-copied across
  both adapters; one copy was missing a 15s exec timeout (GH #70/PANT-24).
- GH #81: `detectVerifiedDone`'s PR-state casing check, hand-copied
  informally across call sites, wrong in the copy nobody re-checked against
  gh's real JSON shape.

Two hand-maintained copies of the same orchestration logic is a standing
invitation for the two to quietly diverge (a bugfix applied to one adapter
and never ported to the other) the next time either needs a change — even
though neither copy is broken today.

## What was NOT duplicated

`assignIssue`/`rerunIssue`/`unassignIssue`/`getIssueRuns` are genuinely
different per adapter (multica CLI args vs pantheon-v2-l2 HTTP calls) —
these are correctly NOT shared; only the transport-agnostic orchestration
logic built on top of them (`dispatch`, `describeLanes`) is extracted.

## Fix

New leaf module `src/router/lib/adapters/spawn-dispatch.mjs`, mirroring
`github-cli.mjs`'s established dependency-injection convention:

- `makeDispatch({ assignIssue, rerunIssue, getIssueRuns, sleep, verifyDelayMs })`
  returns a `dispatch(issue, lane)` closure.
- `makeDescribeLanes({ projectLane, defaultLane, hiveLane, reviewLane, runtimeCap })`
  returns a `describeLanes()` closure.

Imports `classifyRun`/`latestRun` from `../run-classification.mjs` directly
(the real leaf module post-t011, not the `core.mjs` facade — this is a new
module, no re-export-path constraint applies to it).

Both `multica/spawn.mjs` and `pantheon-v2-l2/index.mjs` replace their local
`dispatch()`/`describeLanes()` function bodies with a call to the shared
factories, passing their own already-tested primitives as dependencies. Zero
behavior change — verified by the existing `spawn-adapter.test.mjs` and
`pantheon-l2-stub.test.mjs` suites (which exercise `dispatch()`/
`describeLanes()` through the real adapters) passing unchanged, plus a new
`spawn-dispatch.test.mjs` exercising the shared module directly.

## Scope boundary

No behavior change, no new adapter capability, no touching
`assignIssue`/`rerunIssue`/`unassignIssue`/`getIssueRuns` — purely
organizational, same blast-radius shape as t008.
