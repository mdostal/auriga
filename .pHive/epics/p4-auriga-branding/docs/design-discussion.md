# Design Discussion: Auriga Branding

## 0. Prelude

**NORTH STAR** (from `.pHive/project-profile.yaml`):
Goal: Auriga becomes a generic, standalone top-level orchestrator with pluggable
backlog/spawn adapters, reachable through the pantheon-v2 L2 adapter — no direct
external-system coupling.
Audience: the operator, running many concurrent sessions across many unrelated
projects, wanting Auriga as the top-level dispatcher above all of them.
Pain points: (resolved by `p2-adapter-interface`) tight Multica coupling; (this epic
doesn't touch adapter/routing logic at all — purely a UI/branding pass).

This epic doesn't advance north_star's adapter/standalone goal directly — it's a
branding/visibility pass on top of the already-standalone dashboard (`p3-auriga-ui`).

## 1. What Are We Doing?

Two things, already built, being run through real planning scrutiny after the fact
(explicit operator instruction — keep the implementation, verify it properly): (1) a
public GitHub Pages showcase page that advertises Auriga, and (2) a visual restyle of
the real operator dashboard. Both are synthesized from a 3-way parallel design
exploration the operator reviewed live, not invented fresh here.

"Done": both surfaces exist, are verified against their design sources (not just
self-reported), the full test suite passes, and any real discrepancy between stated
intent and actual implementation is surfaced and explicitly resolved — not silently
passed through.

## 2. What I Found

Independent research (a fresh agent, not the implementers, re-reading every changed
file and re-running the test suite) confirms both surfaces are genuine, faithful
adaptations of their design sources — see `research-brief.md` for the full comparison.
One real discrepancy surfaced: the dashboard's nav has 2 top-level tabs (Epics,
Activity), not 3 (Epics/Story/Activity) as this epic's own stated intent framed it —
Story is drill-down-only. This predates this epic (inherited from `p3-auriga-ui`,
untouched by the restyle's diff) but the framing mismatch is real and needs a decision,
not a silent pass.

Everything else checked out: palette/type/favicon tokens are genuine matches (not
approximations), the constellation diagram is real new work generalized beyond the
2-node example it was built from, install instructions are independently verified
correct against the actual repo structure, and the full test suite (172 + 50 + 8
Playwright specs) is green.

## 3. My Proposed Approach

Given both surfaces are already built and verified, "approach" here is really "what's
left to close the loop":
1. Resolve the 2-tab-vs-3-tab nav discrepancy explicitly (Open Question 1) rather than
   let the epic's own documentation contradict the shipped app.
2. Fix the minor commit-message inaccuracy (7 vs. 8 Playwright specs) — trivial, but
   the operator asked for real scrutiny, and a wrong number in a commit message is
   exactly the kind of small thing that compounds if left unflagged.
3. Present this document + the resolved discrepancy for sign-off, decompose into (or
   reconcile with) story records reflecting what's actually shipped, and close the
   epic — no new implementation work needed beyond whatever Open Question 1 resolves to.

## 4. What Could Go Wrong

- **Low — the nav discrepancy could be dismissed as pedantic** when it's actually a
  real product decision (is 2-tab-with-drilldown the intended information architecture,
  or was 3-tab genuinely wanted and just not implemented). Mitigation: surfaced
  explicitly as Open Question 1, not buried in a research-brief footnote.
- **Low — GitHub Pages isn't actually enabled yet.** `docs/index.html` exists on disk
  but repo Settings → Pages needs to be configured (source: `docs/` folder on `main`)
  before the page is actually publicly reachable. This is a real, separate manual/gh-cli
  step not yet done — flagged so it isn't assumed complete just because the file exists.
- **Low — `docs/review-squad.md` already lives in `docs/`** and will also be served by
  GitHub Pages once enabled (just not linked from `index.html`). Low risk (an internal
  engineering doc being technically reachable if someone knows the URL), but worth
  naming rather than leaving implicit.

## 5. Dependencies and Constraints

- No new runtime dependencies beyond what `p3-auriga-ui` already introduced (Vite,
  Tailwind, shadcn/ui in `src/ui/`) — `docs/index.html` is a single self-contained
  static file, zero dependencies.
- Local validation is the gate (standing project policy) — the independent research
  pass re-ran the full suite itself rather than trusting prior reports, consistent with
  that policy.
- `hive.config.yaml -> developer.pr_style: atomic-prs` — same real-merge-commit
  convention as prior epics.

## 6. Open Questions — RESOLVED (2026-08-18, operator sign-off)

1. **2-tab-vs-3-tab nav discrepancy** — **Resolved: keep the 2-tab drill-down as-is.**
   No new scope; the recommendation in the original draft stands as the operator's
   explicit decision, not an assumption.
2. **Enable GitHub Pages for real** — **Resolved: yes, as part of this epic's closeout**,
   tied directly to the repo visibility change in §9 below (Pages requires a public repo
   or GitHub Enterprise; this repo is going public for exactly this reason).

## 6b. Cross-cutting concerns — explicitly walked (were previously unaddressed, U3)

- **`documentation`** — applies. This story's own closeout is the fix: `.pHive/CONTEXT.md`
  Key paths now lists `src/server/`, `src/ui/`, and `docs/index.html` (none were
  previously documented, not just the `docs/index.html` gap C1 originally flagged), and
  a real "local is the gate" convention entry was added (H3, see below). No further gap
  found.
- **`adapter-boundary-integrity`** — applies only loosely. `docs/index.html` and the
  `src/ui/` restyle are presentation-layer only; neither adds a new call to an external
  system, and neither touches `multica.mjs`/`config.mjs`/an adapter module. The one real
  question this concern raises — whether the hardcoded Multica agent/project UUIDs and
  workspace ID in `src/router/lib/config.mjs`/`config-substrate.mjs` are safe to expose
  now that the repo is going public — was raised and explicitly answered by the operator
  (§9): those identifiers are not treated as sensitive (owned identity, not a secret),
  so no adapter-boundary change is required by this epic. Not a violation.

## 6c. H3 — "local is the gate" — now documented for real

Previously re-asserted as "standing project policy" in two design-discussion drafts
(`p3-auriga-ui`, `p4-auriga-branding`) without ever being written into a repo-visible
doc — flagged by both epics' grill passes. Fixed: `.pHive/CONTEXT.md` → Conventions now
states it explicitly (full local suite + `gh pr merge --admin`; GHA is convenience/
backstop only, not a required check). This closes the recurring gap.

## 6d. H4 — linter now part of verification, and profile corrected

`src/ui/`'s `oxlint` was run as part of this closeout's verification (not skipped, per
the H4 grill finding). `.pHive/project-profile.yaml`'s `code_quality.linters` was stale
(`[]`, predating `p3-auriga-ui`'s oxlint addition) — corrected to `[oxlint]` (C2).

## 6e. P1/P2 — false public-facing claims fixed

- **P1/H1 (was CRITICAL):** `docs/index.html` claimed "Open source... running live"
  while the repo was private. Now resolved structurally — the repo is going public as
  part of this epic's closeout (§9), so "open source" becomes true. "running live" was
  removed from the copy regardless, since it implied a live data connection this static
  showcase page does not have.
- **P2:** the hero's hardcoded static "Last board sync" timestamp + animated pulsing
  "live" dot (no real data connection, confirmed via code read — no fetch/API call
  anywhere on the page) has been replaced with an honest caption: "Sample board shown
  below — a static illustration, not a live feed. Run Auriga locally against your own
  data." The pulsing-dot CSS was removed along with the markup that used it.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: node:test (router + server), Playwright (dashboard + hardening), oxlint (src/ui/)
  Platforms: browser (desktop), both surfaces
  Automated: full existing suite (already independently re-verified in research —
    172 router + 50 server + 8 Playwright, all green) + oxlint (H4 — was previously
    skipped in verification, now run for real) + a re-run after the closeout edits
    in this document (docs/index.html hero copy, CONTEXT.md, project-profile.yaml)
  Manual: none beyond what's already been done (Playwright MCP visual verification
    performed during implementation and re-confirmed during independent research)
  Not verifying: N/A — GitHub Pages reachability is now in scope, not deferred (§9)
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: 1 new file (docs/index.html) + 11 modified files (src/ui/) — already
    landed, verified, tested
  Subsystems: none new — reuses p3-auriga-ui's existing frontend package entirely
  Migration required: no
  Cross-team coordination: no
  Unknowns: 2 open questions above, neither blocking, neither large

  RECOMMENDATION: Small scope — proceed directly to closing the epic (reconcile
  story records with what's shipped, resolve the 2 open questions) rather than H/V
  planning or a structured outline. This is retroactive documentation + one real
  decision point on already-verified, already-working code, not new architecture.
```

## 9. Deep security/PII audit + repo visibility change (operator directive, 2026-08-18)

The operator directed making the repo public, gated on a deep audit ("do a deep dive
check to ensure nothing secret leaked and scrub everything as it goes"), with the public
showcase going live as part of the same visibility change (free GitHub Pages).

**Audit performed:** full tracked-file sweep (not just changed files) for credentials/
tokens/API keys/passwords, PII, and absolute local paths, plus a git-history check on
`src/router/lib/config.mjs` / `config-substrate.mjs` (the two files carrying the bulk of
what was found).

**Findings:**
- **No actual secrets** (API keys, tokens, passwords, `.env`/credential files) in any
  tracked file or in git history. All "secret"/"token" grep hits were false positives
  (test fixtures asserting traversal-guard behavior, `${{ secrets.GITHUB_TOKEN }}` in
  the standard GHA workflow syntax, doc prose about the review squad's security
  perspective).
- **Real Multica operational identifiers ARE present**, and have been since the router's
  first commit (26 of 142 commits touch these two files): a workspace ID prefix, 9 agent
  UUIDs, 17 project UUIDs (including personally-named projects like "House Hunting",
  "Gig Radar"), `HUMAN_NAMES = ['mathew', 'dostal']`, and real private repo names
  (`mdostal/consus`, `mdostal/heimdall`, etc.) — plus `multica --profile dostal` and
  similar operator-identity references threaded through `src/router/agents/*.instructions.md`,
  and a hardcoded `/Users/dostal/.local/bin/multica` fallback CLI path in 3 files.
- `.pHive/agent-complete/` contains many more name hits but is gitignored with zero
  tracked files — confirmed never pushed, not a real exposure.

**Operator disposition (explicit, not assumed):** none of the above is treated as a
secret or a problem. The repo is owned under the operator's own identity (Dostal
Technology, real name already attached), so agent/project UUIDs, workspace IDs, and
human names are not sensitive in this context. **No scrub, no git-history rewrite
performed** — the standing "no destructive git-history rewrite without explicit
confirmation" rule was not triggered because the operator explicitly declined the scrub,
not because it was skipped by default.

**Action taken:** repo visibility flipped to public, GitHub Pages enabled (source:
`docs/` folder on `main`), closing out both the P1/H1 false "open source" claim (now
true) and the epic's namesake deliverable (the showcase page, now actually reachable).
