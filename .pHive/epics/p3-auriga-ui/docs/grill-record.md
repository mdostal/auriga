# Grill Record — p3-auriga-ui

**Source draft:** .pHive/epics/p3-auriga-ui/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — independent subagent read code + docs directly)
**round_number:** 1
**unresolved_count:** 12
**Generated:** 2026-08-17

## Summary

- Vocabulary mismatches: 2 findings
- Hidden assumptions: 2 findings
- Unresolved tensions: 4 findings
- Convention violations: 2 findings
- Posture mismatches: 2 findings

## Vocabulary mismatches

- **V1** — "north_star" is used to mean the UI vision, but the repo's own definition of
  that term (`project-profile.yaml`) is the adapter/standalone-orchestrator goal, which
  never mentions UI/v0/shadcn/self-building. `CONTEXT.md` ties "north_star" specifically
  to the landed adapter work and cites VISION §③, not §④, as its precursor.
  - Question for planner: should the doc distinguish "north_star" (the standalone/
    adapter goal) from "the recorded future UI vision" (VISION §④), since this repo's
    own vocabulary treats them as two distinct things?

- **V2** — "component-registry/genUI pattern" is invoked for the chat panel, but the
  described feature (tool-calling to answer text questions) doesn't match the research
  brief's own definition of that pattern (the LLM selecting/rendering a UI component).
  - Question for planner: does the chat panel actually render selectable UI components,
    or is this label overclaiming a plain grounded-Q&A feature?

## Hidden assumptions

- **H1** — the claimed "standing project policy: no GitHub Actions dependency for
  acceptance" isn't a documented policy and is in tension with `ci.yml`'s own header
  ("THE gate") and `project-profile.yaml`'s CI description. The real precedent (p2's
  "no live Multica in tests") is narrower than what this draft asserts.
  - Question for planner: where is "no GHA dependency, local is the gate" established
    as policy, distinct from p2's narrower test-suite decision?

- **H2** — the Verification Strategy calls browser interaction irreducibly "Manual"
  without acknowledging Playwright MCP tooling is available in this session and could
  automate exactly those checks.
  - Question for planner: was automating the two "Manual" steps considered and
    rejected, or just not evaluated?

## Unresolved tensions

- **U1** — the "Manual" verification steps have no stated enforcement mechanism; if
  `ci.yml`'s automated suite is the only real gate, "Manual" is effectively best-effort.
  - Question for planner: what actually prevents merge if the manual checks are skipped?

- **U2** — the epic's "Done" bar requires a working LLM chat panel (live external
  network call, operator-supplied key), but `north_star.success` says "runs fully
  standalone" and `north_star.avoid` forbids direct external-system integrations.
  - Question for planner: does "standalone" tolerate a hard external LLM dependency in
    "Done," or does the chat panel need a degraded/offline mode?

- **U3** — VISION §④ explicitly warns against defaulting to "a plain hand-coded
  dashboard"; the proposed Dashboard v1 is exactly that shape.
  - Question for planner: is Dashboard v1 the thing §④ warned against, and if starting
    hand-coded (with shadcn) is meant to ease a later transition, should that
    reconciliation be stated explicitly?

- **U4** — (unverifiable from repo files, noted for the record) a possible tension
  against a prior "keep going" instruction not captured in any repo file — gating on
  four open questions (one epic-shape-defining) before stories are written.
  - Question for planner: does pausing for sign-off here honor or conflict with that
    instruction?

## Convention violations

- **C1** — new nested `package.json`s for `src/server/`/`src/ui/` would be invisible to
  `ci.yml`'s root-only `npm install && npm test` step; the draft never says how their
  tests actually get invoked.
  - Question for planner: how do the new packages' test suites actually run, given
    `ci.yml`'s current single root-only step?

- **C2** — no decision recorded on lint/format tooling for the new frontend package,
  despite the repo having none anywhere today and Vite/shadcn scaffolds typically
  bringing ESLint/Prettier by default.
  - Question for planner: is adopting the scaffold's default lint/format tooling
    intentional, and should it be called out as a separate departure from the repo's
    current zero-lint convention?

## Posture mismatches

- **P1** — the LLM API proxy is a new, direct integration to an external system with no
  adapter interface (no `llmAdapter` typedef, no stub/mock matching the established
  `backlogAdapter`/`spawnAdapter`/`pantheon-v2-l2` pattern) — in apparent tension with
  `adapter-boundary-integrity` and the `pantheon-v2-l2` stub-first precedent ("building
  the real integration is a separate epic, not Auriga's job").
  - Question for planner: is the LLM integration exempt from `adapter-boundary-integrity`
    because it's scoped to a new web layer rather than "Auriga's core," or should it
    follow the same adapter-with-stub pattern as everything else?

- **P2** — the dashboard reads `.pHive/` story `status:` fields directly, bypassing
  `backlogAdapter` (whose own definition is "read/write whatever system tracks work
  items... set status"), without engaging `hive.config.yaml`'s own comment flagging this
  class of decision as "reconsider once the generic backlog adapter interface exists."
  - Question for planner: should the dashboard's direct `.pHive/` reads be reconciled
    with that comment, or is "Auriga's own local planning state" a sufficient, permanent
    distinction from "board state Auriga routes"?

## Notes

Repo-state claims in the draft were independently re-verified against the actual working
tree (no `src/server/`/`src/ui/` exist, both `package.json`s are dependency-free,
`ci.yml` runs root-only and is documented as "THE gate", `supervisor.sh` has no
awareness of other processes) — all held up. The findings above are about framing,
unstated tensions, and an architectural boundary question, not factual errors about the
codebase.

## Out of scope (this pass)

Grill does not propose solutions, score quality, gate work, or prioritize findings. Each
finding above ends with a question for the planner; resolution happens in the
design-discussion revision that follows this record.
