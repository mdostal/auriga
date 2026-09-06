# Design discussion: t009-issue-status-constants

## Goal

Third of four agreed workstreams from the 2026-09-05 codebase-wide cleanup
discussion: apply the same "no hardcoded strings" fix already shipped for
GitHub's PR-state enum (`github-pr-state.mjs`, GH #81) to the issue-status
vocabulary scattered through `core.mjs` and `auriga-router.mjs`.

## An honest scope note vs. the PR-state case

`GITHUB_PR_STATE` mirrors a verified, public, documented external enum
(GitHub's own `PullRequestState`). This module does NOT have that same
grounding — this session has no live access to Multica's own API docs to
confirm its issue-status vocabulary is complete or authoritative. `
ISSUE_STATUS` instead names the values this router has empirically relied
on and observed to date. This is still worth doing (same "name it once"
principle), but it is not the same class of claim, and the module's own
header comment says so explicitly rather than overclaiming a verified
mirror it isn't.

## Research (wider than originally scoped)

Grepped both `core.mjs` and `auriga-router.mjs` for raw issue-status string
literals. Found more than the original proposal named (which said
"core.mjs" only): `auriga-router.mjs` had just as many, if not more —
14 occurrences across comparison sites, `setIssueStatus()` write calls, and
`logImpl()` log payloads. Also found a real, in-file duplication while
reading `core.mjs` closely: the exact `done || cancelled || canceled`
"is this issue terminal" check was hand-copied as a local `const terminal =`
closure in THREE separate functions (`depsSatisfied` inline,
`descDepsSatisfied`, `detectParentDone`).

**RUN status left out of scope, deliberately.** `ACTIVE_RUN_STATUSES`/
`FAILED_RUN_STATUSES` (a run/task's own lifecycle — queued, dispatched,
started, failed, errored, timeout, etc.) is a separate vocabulary from issue
status. No comparison-site duplication of these specific values was found
(unlike issue status and PR state) — nothing to de-drift yet, so nothing
extracted, per the no-pre-emptive-integrations principle.

## Fix

New `src/router/lib/issue-status.mjs`: `ISSUE_STATUS` (todo, blocked,
in_progress, in_review, done, cancelled, canceled, shipped, complete,
pending, running), `ISSUE_STATUS_ALT_SPELLINGS` (the one real
space-vs-underscore spelling variant this router's own defensive code
already handled, kept exactly, not silently merged), and
`isTerminalIssueStatus(status)` (done OR cancelled OR canceled) —
collapsing the three hand-copied `terminal` closures into one shared
function.

Replaced every raw literal comparison AND every `setIssueStatus()`/
`logImpl()` status-value write site in both `core.mjs` and
`auriga-router.mjs` with the named constants, for full consistency (not
just the comparison sites) per the operator's blanket "no hardcoded
strings anywhere" direction.

## Incidental fix found during verification

Running the full e2e/hardening suite surfaced a real, pre-existing bug in
this session's OWN earlier `t008` epic docs: a story YAML's `purpose:`
field value contained an unquoted `{ env: cleanEnv }`, which the `yaml`
package's compact-mapping rules rejected as a malformed nested mapping.
Harmless in practice (the server's graceful-degradation path skipped it,
logging a warning rather than crashing), but a real defect — fixed by
quoting the value.

## Verification

Added `src/router/test/issue-status.test.mjs` (5 tests) covering the
constants and the collapsed `isTerminalIssueStatus` helper directly. Full
`npm run test:all` green throughout (330 router tests, up from 326; 52
server; 8 e2e/hardening) with zero remaining issue-status string literals
in either file (verified by grep, not assumed).

## Scale

Small-to-medium — wider blast radius than initially scoped (both files, not
just one), but every change is a mechanical literal-to-constant swap with
identical runtime values, backed by full existing + new test coverage.
