# Grill Record — p2-adapter-interface

**Source draft:** .pHive/epics/p2-adapter-interface/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — independent subagent read code + docs directly)
**round_number:** 1
**unresolved_count:** 7
**Generated:** 2026-08-15

## Summary

- Vocabulary mismatches: 1 finding
- Hidden assumptions: 1 finding
- Unresolved tensions: 2 findings
- Convention violations: 2 findings
- Posture mismatches: 1 finding

## Vocabulary mismatches

- **V1** — `VcsAdapter` is a third adapter kind not present anywhere in the project's
  canonical two-adapter model. `project-profile.yaml -> north_star.goal` and
  `CONTEXT.md` both define the boundary as exactly two kinds (backlog +
  persona/spawn). The draft used `VcsAdapter` confidently in §3 steps 1 and 6 while
  only flagging it as "Open Question #1" — the term reads settled even though it
  isn't.
  - Draft location: §3 step 1, §3 step 6
  - Reference: `.pHive/project-profile.yaml -> north_star.goal`, `.pHive/CONTEXT.md`
  - Question for planner: If `VcsAdapter` is adopted, should CONTEXT.md/north_star's
    two-adapter language be revised to three, and does that ripple into how the
    `adapter-boundary-integrity` cross-cutting concern is worded?

## Hidden assumptions

- **H1** — The risk register understates which passes depend on GitHub PR-discovery,
  calling it "REVIEW_LANE code." Verified against `auriga-router.mjs`: `gh`-backed PR
  discovery (`ghPrs`/`ghOpenPrs`/`ghListRepos`) also gates the blocked→todo unblock
  pass, the cascade re-dispatch pass, and the false-done/review-scan pass — three
  state-machine passes beyond the review lane itself.
  - Draft location: §4 ("Medium — the `gh` vs. Multica split...")
  - Why this matters: the risk severity/mitigation is scoped to "review lane," but the
    actual blast radius is core dispatch/cascade/unblock logic.
  - Question for planner: Given `gh`-based PR discovery gates unblock and cascade
    transitions (not just review dispatch), does the risk severity/mitigation for
    Open Question #1 need to be re-scoped?

## Unresolved tensions

- **U1** — The draft asserts a decided answer to a question it later reopens as
  unresolved (Vulcan hook placement). §3 step 1 states as settled: Vulcan
  provisioning "becomes an optional pre-dispatch hook the `SpawnAdapter`
  implementation may call." §6 Open Question 3 reopens the identical question and
  leans the opposite way (separate pre-dispatch middleware, NOT on `SpawnAdapter`).
  - Draft location: §3 step 1; §6 Open Question 3
  - Tension: two different architectures for the same integration point, presented
    as both decided and open in the same document.
  - Question for planner: Which placement is actually being proposed — is §3 step 1
    stale relative to §6 Q3's later reasoning, or is §6 Q3 the real open item?

- **U2** — Splitting out `VcsAdapter` (step 1) isn't reflected in the `cycle()`
  options-bag rewire (step 6), which still describes only a two-way `backlog` +
  `spawn` split. 25 call sites across `mcaImpl.*` in `auriga-router.mjs` mix backlog,
  spawn, and gh/VCS calls — if `VcsAdapter` is real, all 25 need a three-way triage,
  not two.
  - Draft location: §3 step 1 vs. §3 step 6
  - Tension: step 6's "signature change, not architecture change" framing assumes
    two adapters; step 1 proposes three.
  - Question for planner: Does the `cycle()` options-bag rewire need to name `vcs` as
    a third injectable, and does that change the scale-assessment framing?

## Convention violations

- **C1** — Placing new adapter test files outside `src/router/test/` would make them
  invisible to the actual CI gate. Root `package.json`'s only script is
  `node --test src/router/test/*.test.mjs` (non-recursive glob); `ci.yml` runs
  `npm test`. The draft proposes a top-level `src/adapters/` directory without
  specifying where its tests live.
  - Draft location: §3 step 1 (directory proposal), §3 step 7 (test acceptance bar)
  - Convention: root `package.json` test script; `.pHive/CONTEXT.md -> Conventions`
  - Question for planner: Where do the new adapter/interface-contract tests
    physically live, and does the test glob need to change to discover them?

- **C2** — PascalCase, class-suggestive adapter names (`BacklogAdapter`,
  `MulticaBacklogAdapter`, `StubSpawnAdapter`, etc.) appear nowhere else in this
  codebase. Zero `class` declarations exist anywhere in `src/router/`; the stated
  convention is camelCase functions/vars, SCREAMING_SNAKE_CASE constants, no OOP.
  - Draft location: §3 step 1-3 (naming throughout)
  - Convention: `.pHive/project-profile.yaml -> conventions.naming`
  - Question for planner: Are these meant to be ES6 classes (a first for this
    codebase), or plain function/object-exporting modules using PascalCase as a
    label only — and if classes, is that an intentional, acknowledged departure?

## Posture mismatches

- **P1** — Deferring the queue UI is presented as sourced from north_star ("per the
  kickoff's north_star"), but north_star's `goal` and `success` fields bundle
  "queue + UI" into the standalone success bar as ONE deliverable, not a phased one.
  `has_ui: true` is annotated "not speculative." The draft's narrower "Done" bar for
  this epic isn't wrong, but attributing the cut to north_star as if already settled
  there isn't accurate — north_star doesn't state that phase split.
  - Draft location: §1 ("What Are We Doing?")
  - Posture reference: `.pHive/project-profile.yaml -> north_star.goal`, `.success`
  - Question for planner: Is deferring the queue UI an explicit scoping decision
    being made BY this design discussion (and should it be justified as such), or
    is there a different source establishing this phase split?

## Notes

The independent reviewer verified several of the draft's factual claims directly
against the code (call-site counts, class-declaration absence, test-glob behavior)
rather than trusting the draft's assertions — all cited findings are grounded in
actual file contents, not speculation.

## Out of scope (this pass)

Grill does not propose solutions, score quality, gate work, or prioritize findings.
Each finding above ends with a question for the planner; resolution happens in the
design-discussion revision that follows this record.
