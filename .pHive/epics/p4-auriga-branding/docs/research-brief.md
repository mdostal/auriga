# Research Brief: Auriga Branding (GitHub Pages showcase + dashboard restyle)

**Epic:** p4-auriga-branding
**Requirement:** synthesized from a 3-way parallel design exploration (Concepts A/
Mission-Control, B/Star-Atlas, C/Editorial), reviewed live by the operator as published
Artifacts. Two surfaces: a public GitHub Pages showcase (Concept B near-as-is + real
marketing content) and a visual restyle of the existing operator dashboard (Concept B's
visual language, Concept A's tab navigation kept).

**Note on sequencing:** both pieces were already implemented and committed on this
branch (`b91e070`, `c035a2b`) via direct agent dispatch before this formal plan ran, per
explicit operator instruction: keep the implementation, but run it through the real
Hive process afterward so genuine scrutiny — not a rubber stamp — still happens. This
brief and the design-discussion that follows are written against the ACTUAL landed
code, verified independently (a fresh research pass re-read every changed file and
re-ran the full test suite rather than trusting prior self-reports).

## 1. docs/index.html — verified genuine near-as-is match to Concept B

Token-for-token identical palette (`--bg-void:#0a0d18`, `--capella:#f3c667`,
`--star-done:#bcd6ff`), identical font stack (Iowan Old Style / Optima / SF Mono),
identical Plate I/II/III structure, identical starfield canvas, identical Charioteer's
Pentagon favicon. New marketing content (`#about`, `#install`, hero CTA row, footer
links) is clearly additive — separate CSS classes, no collision with ported styles.

**Install instructions independently verified correct** against the real repo
structure: `cd src/router && npm test` matches `src/router/package.json`; `cd ../ui &&
npm install && npm run build` matches `src/ui/package.json`; `cd ../server && npm
install && node index.mjs` — confirmed `src/server/index.mjs` actually listens on
`PORT || 8787` and serves `src/ui/dist/` as static files, degrading to 404 if unbuilt.
The documented flow is accurate, not just plausible-looking.

## 2. src/ui/ restyle — verified genuine adaptation, tab navigation kept

`App.jsx` still uses `useState`-based route switching, no scroll/anchor logic — the
diff only touched className strings, not structure. `index.css`/`tailwind.config.js`
reuse Concept B's exact hex values (documented HSL→hex substitution, explained in a
code comment) exposed as first-class Tailwind color tokens. No leftover generic shadcn
classes found in any changed view.

## 3. Dependency constellation diagram — verified genuinely new, generalized

`src/ui/src/components/DependencyConstellation.jsx` (128 lines) reproduces Concept B's
exact vertical rhythm but computes width dynamically per dependency count/label length
— a real generalization beyond the reference's hardcoded 2-node markup. A code comment
explains why dependency-node status isn't shown (the read layer doesn't resolve
per-dependency status, so it correctly avoids fabricating it rather than guessing).

## 4. Test suite — independently re-run, all green

`npm run test:all`: router 172/172, server 50/50, `vite build` succeeds, `test:e2e`
4/4, `test:e2e:hardening` 4/4. **8 Playwright tests across 5 spec files** total.

## 5. Real discrepancy found — worth a decision, not silent

**The dashboard's top-level nav has 2 tabs (Epics, Activity), not 3 (Epics/Story/
Activity) as the epic's stated intent framed it.** Story detail is reachable only by
drilling down from an epic's story list — a comment in the code documents this as
intentional ("not from the top nav, matching the story's flow"). Concept A's own
reference mockup had 4 top-level tabs (Epics/Story Detail/Activity Log/Mark).

Critically: **this is not a regression introduced by this epic** — the 2-tab nav
already existed before the restyle (confirmed via `git show c035a2b -- src/ui/src/
App.jsx`: the diff only changed classNames, not the nav item list). It predates this
epic, from `p3-auriga-ui`. But the epic's own framing ("keeping Concept A's tab-based
navigation — Epics/Story/Activity") doesn't match either the current app or Concept A's
literal reference. This needs an explicit decision, not silent pass-through: is
drill-down-only Story access fine (current, unchanged behavior), or should Story become
a real third top-level tab to actually match the stated 3-tab intent?

## 6. Minor accuracy note

The `p4-dashboard-restyle` commit message says "7 Playwright specs"; the real count is
8 tests across 5 spec files. Not a functional problem, just a commit-message inaccuracy
worth noting for the record.

## Open items for design discussion

- Resolve the 2-tab-vs-3-tab nav discrepancy explicitly (§5) — accept as-is (pre-existing,
  out of this epic's actual scope) or fix it now while we're in this code.
- Confirm scale assessment: both surfaces are done, verified, tested — this is smaller
  and lower-risk than a from-scratch build. Likely Small-to-Medium, not Large.
