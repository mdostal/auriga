# Design discussion: t002-false-done-thrash-fix

## Goal

Stop `detectFalseDone` from demoting a genuinely-shipped story back to
`in_review` forever, which currently starves an entire tenant's dispatch loop
(GitHub issue #76 / triage t-002, priority p0).

## Root cause (verified against live code, not assumed)

- `detectVerifiedDone` (`core.mjs:446`) and `detectFalseDone` (`core.mjs:838`)
  both classify a story from the SAME per-cycle `candidatePrs` scan
  (`auriga-router.mjs`'s `listCandidatePullRequests()`, gathered fresh once
  per cycle — confirmed NOT cached/stale across cycles, ruling out the
  caching-bug hypothesis this epic started with).
- `detectVerifiedDone` uses the LOOSE matcher (`prMatchesStory` — identifier
  anywhere in branch/title/body). `detectFalseDone`'s FALLBACK path (used
  whenever the issue has no recorded `ownPrUrl`) uses the stricter
  `prIdentityMatchesStory`, but only requires ONE identity-matching PR to
  still be open — it does not check whether the SAME story also has a
  MERGED identity-matching PR.
- **Confirmed nothing in this codebase ever writes `metadata.pr_url` or a
  `pr_url:` description line** (grepped `core.mjs` + `auriga-router.mjs` —
  `ownPrUrl` is read-only). So `detectFalseDone`'s "authoritative path" is
  dead in practice for every real story; 100% of stories go through the
  fuzzy fallback.
- Net effect: if a story has BOTH a merged PR (making `detectVerifiedDone`
  advance it to `done`) AND a separate, unrelated-but-loosely-matching still
  -open PR in the same target repo (a stale/abandoned retry, a PR that
  merely mentions the ticket id in its body, etc.), the two detectors
  disagree every cycle and the story thrashes `done` <-> `in_review`
  forever — exactly PANT-4's observed behavior (linked merged PR
  `mdostal/heimdall#85`, presumably a second stray open PR also
  identity-matching PANT-4 in the same repo).

## Fix

In `detectFalseDone`'s fallback branch (core.mjs, no recorded `ownPrUrl`):
before demoting on a found open identity-matching PR, also check whether the
SAME candidate PR set contains a MERGED PR that identity-matches the story
(repo-qualified, same matcher). If one exists, the story is genuinely done —
a merged PR beats a stray open one referencing the same ticket — so skip the
demotion instead of firing it.

This is a minimal, self-contained change to one function's fallback branch.
It does not touch the authoritative `ownPrUrl` path (unchanged), does not
touch `detectVerifiedDone`, and does not introduce async or touch any
adapter/transport code — pure-code state-machine logic only, matching this
repo's existing `detectFalseDone` fix precedent (PAN-6952, same function,
same "avoid false-positive demotion on a merely-matching PR" shape).

## Risks

- Low. The change only ADDS a guard that suppresses a demotion action; it
  cannot cause a new demotion that wasn't already firing, and it cannot
  block a legitimate false-done catch (a story with an open PR and NO merged
  identity-matching PR anywhere still demotes exactly as before).
- Existing `core.test.mjs` coverage for `detectFalseDone` (PAN-6952 case,
  authoritative-path cases) must keep passing unchanged.

## Scale

Small — one function, one file, additive guard, full existing test coverage
to lean on. Design discussion is sufficient; no H/V planning needed.
