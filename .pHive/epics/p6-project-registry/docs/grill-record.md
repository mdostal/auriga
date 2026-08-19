# Grill Record — p6-project-registry

**Source draft:** .pHive/epics/p6-project-registry/docs/design-discussion.md
**round_number:** 1
**unresolved_count:** 7 (0 CRITICAL, 2 close to blocking — findings 1 and 2)

## Summary

- Hidden assumptions: 4
- Unresolved tensions: 2
- Vocabulary mismatches: 1

**Verified accurate (no finding, stated for calibration):** PROJECT_IDS as the real
dispatch gate, silent exclusion confirmed (no log line fires). PROJECT_IDS
order-sensitivity. PROJECT_NAMES's safe fallback at all 3 read sites. PROJECT_LANE's
unconditional DEFAULT_LANE fallback. `listAllProjectIds()` genuinely discards all
fields but `.id`. The "ported extra" pattern genuinely matches
`listAllIssues`/`listCandidatePullRequests`'s shape. `config-substrate.mjs` has zero
consumers outside `src/router`. The real Multica project-list JSON shape is genuinely
unconfirmed anywhere in this repo (checked a recovered historical TS adapter too — it
only covers issue shape, not project-list shape).

## Hidden assumptions

- **H1** — The "4 active / 13 deferred" framing in Open Question 2 isn't clean: MINERVA
  is in `PROJECT_NAMES` (17) but not `PROJECT_IDS` (4) — yet MINERVA IS one of
  `PROJECT_LANE`'s 5 hardcoded entries, pinned by `spawn-adapter.test.mjs`'s explicit
  "exactly 5 mapped project UUIDs" assertion. It's excluded from dispatch but load-
  bearing in routing policy — not inert like the other ~12. Does the migration plan
  need to explicitly account for entries like this?
- **H2** — Slice 2's "read a JSON file at ESM import time" is a genuinely new pattern
  in this codebase (grepped — zero existing top-level `readFileSync` outside test
  files). `spawn-adapter.test.mjs` directly imports `PROJECT_LANE` etc. from
  `config-substrate.mjs` — after this refactor, that test (unrelated to the registry
  feature) would fail to even load if the new JSON file is missing/malformed. Treated
  as a risk-free mechanical detail in the draft — is it?
- **H3** — No rollback path named if the byte-identical `PROJECT_IDS` verification
  (§4's own mitigation) fails. What's the actual procedure on a mismatch?
- **H4** — Concurrent-write/hand-edit risk on the committed JSON file is never named,
  positively or as dismissed. Considered out of scope by omission, or not considered?

## Unresolved tensions

- **U1** — §5's claim that this epic "removes hardcoded values... satisfying the
  concern's own checklist item directly" overclaims: `projects.json` is itself static
  data until the CLI mutates it — this relocates hardcoding into a smaller,
  operator-mutable surface, it doesn't eliminate the category. Is "removes hardcoding"
  the right characterization, or should the epic record say "relocates"?
- **U2** — `spawn-adapter.test.mjs`'s specific existing assertions against
  `config-substrate.mjs`'s real (non-fixture) exports (`deepEqual(lanes.projectLane,
  PROJECT_LANE)`, an exact 5-key-count check) aren't named explicitly in the
  verification strategy — folded into generic "full suite stays green." Should this
  specific test be called out as "must pass unchanged" given Slice 2 changes how the
  module populates?

## Vocabulary mismatches

- **V1** — Research brief §3's "exactly one real write site exists today" is
  measurably wrong: grep finds 3 write call-sites across 2 files
  (`auriga-router.mjs`'s PID + log writes, `reroute-hive-off-codex.mjs`'s log append),
  not 1. The substantive conclusion (no committed-state precedent, all default to
  `/tmp`) still holds, but the count itself doesn't survive a literal grep.

## Out of scope (this pass)

Grill does not propose solutions. Resolution happens in the design-discussion revision
and, where genuinely a judgment call (H1's migration scope, H3's rollback procedure,
H4's concurrent-write posture), in direct operator sign-off.
