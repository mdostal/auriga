# Design discussion: t012-heimdall-dev-lane-fix

## Goal

Fix GitHub issue #80: `heimdall-dev` confirmed live (via a cross-session
peer with production access) to not exist as a real Multica agent at all in
the corrected workspace (`f32af269-...`) — only `heimdall-dev-codex` does.

## Widened during investigation: this was a real dispatch bug, not just a gap

Reading `chooseAgentForProject` (core.mjs) closely: it sorts a lane's
eligible candidates by lowest `inflight + projected` load, breaking ties by
lane order. A nonexistent agent's inflight count is always 0 (nothing ever
successfully assigns to an id that resolves to no real agent) — so
`heimdall-dev`, listed FIRST in `projects.json`'s Heimdall lane, always won
the tie-break against `heimdall-dev-codex`. `spawn.assignIssue('heimdall-
dev', ...)` would then fail with a real error (the pantheon-v2-l2 adapter's
`resolveAgentId` 404s), caught by `auriga-router.mjs`'s try/catch and
logged as `assign_error` — the cycle survives, but the story stays
unassigned and gets re-picked next cycle, likely selecting `heimdall-dev`
again. This means Heimdall dispatch may never have successfully reached
`heimdall-dev-codex` at all, not a graceful fallback as the original
`projects.json` note claimed.

## Fix

Pruned `heimdall-dev` from `projects.json`'s Heimdall lane list (now just
`['heimdall-dev-codex']`). Left the `heimdall-dev` entry in
`config-substrate.mjs`'s `AGENTS` in place (harmless with no lane
referencing it) but corrected its comment, which had wrongly claimed a safe
fallback existed — documented the real confirmed-nonexistent status and a
note to re-verify live before ever re-adding it to a lane.

## Verification

Updated the existing "HARD GATE" test in `project-registry.test.mjs` that
hardcodes the real `PROJECT_LANE` shape (would have caught this drift
immediately had it existed before). Added a new regression test proving
`chooseAgentForProject` against the REAL, live-loaded config can only ever
select `heimdall-dev-codex` for the Heimdall project now — not a synthetic
fixture that could pass even if `projects.json` regressed. Full `npm run
test:all` green (361 router tests, up from 360; 52 server; 8 e2e/hardening).

## Scale

Small — a one-line data fix (pruning a stale lane entry) plus a corrected
comment and two updated/new tests. No decision-logic changes.
