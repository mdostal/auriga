# Design discussion: t008-github-cli-dedup

## Goal

Second of four agreed workstreams from the 2026-09-05 codebase-wide cleanup
discussion. Extract the gh-CLI helper logic hand-copied across
`multica/backlog.mjs` and `pantheon-v2-l2/index.mjs` into one shared
module, closing a real drift risk the same class as GH #81's bug.

## Research (real, found by reading both files closely)

`pantheon-v2-l2/index.mjs`'s own header comment already admitted
`ghRun`/`ghListRepos`/`ghPrs` were "ported from multica/backlog.mjs's own
ghRun/ghListRepos/ghPrs (same GH binary, same env passthrough, same
flags/limits)". Confirmed by diffing them directly:

- **Real, live drift found**: `pantheon-v2-l2/index.mjs`'s `ghRun` has a 15s
  `timeout` (added 2026-08-29 for a real incident, PANT-24 — a single
  hanging repo stalled the entire board-wide PR scan indefinitely).
  `multica/backlog.mjs`'s `ghRun` had **no timeout at all** — the fix was
  never ported back. If `multica/backlog.mjs` is ever used live again (a
  fallback path, a reverted cutover, a future standalone deployment), it
  would silently reintroduce the exact bug #70 already fixed once.
- **Real, deliberate difference (preserved, not unified away)**:
  `multica/backlog.mjs` scrubs `MULTICA_*` env vars via `cleanEnv()` before
  every gh call (that process holds real Multica credentials elsewhere);
  `pantheon-v2-l2/index.mjs` passes `process.env` straight through (that
  container holds none by design). This is architecture, not drift.
- **A third, in-file duplication** found while reading `multica/backlog.mjs`
  alone: the exact `repos = new Set([...ghListRepos(...), ...searchRepos])`
  gathering loop appears TWICE in that one file (`listCandidatePullRequests`
  and `getIssuePullRequests`'s own narrower per-identifier fallback) — on
  top of the third copy in `pantheon-v2-l2/index.mjs`.

## Fix

New `src/router/lib/adapters/github-cli.mjs`, following the exact
dependency-injection convention `multica/cli-runner.mjs` already
established for the same reason (execFileSync must be injected, never
imported, so each test file's own `t.mock.module` + cache-busting dynamic
import still works):

- `makeGhRun(execFn, gh, { env })` — `env` is a thunk, defaulting to
  `() => process.env`, so a caller needing per-call freshness (cleanEnv())
  still gets it. The 15s timeout is now baked into this ONE function, so
  both adapters get it unconditionally — the fix that was previously stuck
  in only one of two copies.
- `makeGhListRepos(ghRun)` / `makeGhPrs(ghRun)` — pure factories over the
  now-shared `ghRun`.
- `gatherReviewRepos(ghListRepos, owner, searchRepos)` — the repo-gathering
  set-union logic, closing the third (in-file) duplication too.
- `makeListCandidatePullRequests(ghListRepos, ghPrs, owner, searchRepos)`.

Both adapters now import and wire these instead of carrying their own
copies. `multica/backlog.mjs` passes `{ env: cleanEnv }`;
`pantheon-v2-l2/index.mjs` uses the default (`process.env`).

## Verification

Added `src/router/test/github-cli.test.mjs` (7 new tests) exercising the
shared module directly. Added one new regression test to
`backlog-adapter.test.mjs` asserting `multica/backlog.mjs`'s gh calls now
carry the 15s timeout — proving the drift is actually closed, not just
structurally refactored. Relied on that file's pre-existing `cleanEnv()`
test for env-scrubbing coverage (unaffected, still passing). Full `npm run
test:all` green throughout (326 router tests, up from 318; 52 server; 8
e2e/hardening).

## Scale

Small-to-medium — a real refactor across three files, but every call site's
observable behavior is either unchanged or a confirmed bug fix (the
timeout), with full existing + new test coverage.
