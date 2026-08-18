# Grill Record — p4-auriga-branding

**Source draft:** .pHive/epics/p4-auriga-branding/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — independent subagent verified against live repo + GitHub API)
**round_number:** 1
**unresolved_count:** 12
**Generated:** 2026-08-18

## Summary

- Vocabulary mismatches: 1
- Hidden assumptions: 4
- Unresolved tensions: 3
- Convention violations: 2
- Posture mismatches: 2

## Vocabulary mismatches

- **V1** — "Done" quietly redefines "showcase"/"advertises" (public-reachability
  implied) down to "the file exists on disk." GitHub Pages isn't enabled.

## Hidden assumptions

- **H1 (CRITICAL)** — `docs/index.html` claims "Open source... running live" and links
  "View source on GitHub" — but `gh api repos/mdostal/auriga` confirms `private: true,
  license: null`. The claim is false as written; a visitor who clicks through hits a
  private repo.
- **H2 (CRITICAL)** — Making the repo public (the only way H1's claim becomes true)
  would expose real, currently-private data already hardcoded in the codebase:
  `src/router/lib/config.mjs` contains a live Multica workspace ID comment
  (`7feca4c9-...`) and `HUMAN_NAMES = ['mathew', 'dostal']`, plus (per prior kickoff
  research) 9 real agent UUIDs and 17 real project UUIDs. Neither draft document
  considered this before treating "enable Pages" as a low-risk toggle.
- **H3** — Design-discussion §5 re-asserts "local is the gate (standing project
  policy)" as settled fact — the exact claim `p3-auriga-ui`'s own grill-record already
  found ungrounded (no such policy is documented anywhere in the repo). Never resolved
  since, now repeated a second time.
- **H4** — Verification claims "all green" without running `src/ui`'s own `oxlint`
  script, despite 10 of the epic's changed files living in `src/ui`. (Independently run
  during this grill: passes, 1 non-blocking warning — no hidden failure, but the gap in
  verification rigor is real.)

## Unresolved tensions

- **U1** — `north_star.audience` is explicitly "the operator" (personal/internal use),
  and `CONTEXT.md`/`VISION.md` frame Auriga purely as internal infrastructure. Nothing
  in any project doc states a public-marketing/showcase goal. The draft names this gap
  but doesn't argue why the epic belongs on this project's stated identity.
- **U2** — GitHub Pages being unlive is filed as a "Low" risk, not a blocker, for what
  is this epic's headline, namesake deliverable — and given H1/H2, "enable Pages" isn't
  actually the simple toggle Open Question 2 implies.
- **U3** — Neither of `.pHive/cross-cutting-concerns.yaml`'s two defined concerns
  (`documentation`, `adapter-boundary-integrity`) is explicitly walked, even to mark
  not-applicable.

## Convention violations

- **C1** — `docs/index.html` (new, permanent, user-facing) isn't added to `CONTEXT.md`'s
  Key paths, unlike `docs/review-squad.md` which already is.
- **C2** — `project-profile.yaml`'s `code_quality.linters: []` / zero-lint
  characterization is stale (predates this epic, from `p3-auriga-ui`'s `oxlint`
  addition) and this epic's own "reconcile docs against reality" charter doesn't
  correct it.

## Posture mismatches

- **P1 (CRITICAL, same root cause as H1)** — "Open source" is a direct, verifiably
  false overstatement on the one page meant to represent Auriga credibly to outsiders.
- **P2** — The hero shows a hardcoded, static "Last board sync" timestamp next to an
  animated pulsing "live" dot with zero actual data connection (confirmed: no fetch/API
  call anywhere in the page's script). This will silently go stale and misrepresents a
  live connection that doesn't exist — in tension with this same epic's own praise for
  `DependencyConstellation.jsx` correctly refusing to fabricate status it doesn't have.

**Checked, clean:** no re-introduction of the Janus-misattributed self-building/LLM
content VISION.md §④ removed.

## Notes

Independently re-verified via `gh api`, direct file reads, and re-running the test
suite (including the linter, which neither prior document had run) rather than
trusting the draft's self-report.

## Out of scope (this pass)

Grill does not propose solutions. Each finding ends with a question for the planner;
resolution happens in the design-discussion revision and, for H1/H2/P1/U1/U2, in
direct operator sign-off — these are real judgment calls, not something to silently
resolve.
