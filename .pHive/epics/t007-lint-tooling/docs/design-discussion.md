# Design discussion: t007-lint-tooling

## Goal

First of four agreed workstreams from the codebase-wide cleanup discussion
(2026-09-05): wire up real, enforced linting across the whole repo and fix
every finding it surfaces, rather than leaving `src/ui`'s existing oxlint
install disconnected and every other package with zero lint tooling.

## Research (real, ran against the live repo, not hypothetical)

- Root, `src/router`, `src/server`: no lint config anywhere.
- `src/ui` has `oxlint` + a `lint` script, but `test:all` never calls it —
  disconnected from the actual verify pipeline.
- Ran `oxlint` against `src/router` + `src/server` directly: 17 real
  findings (dead code, unused vars/params, useless length checks before
  `.some()`, useless spread fallbacks). `src/ui`'s own lint had 1 existing
  warning (a standard shadcn/ui `cva()`-export pattern, not a real defect).
- `oxlint --deny-warnings` exists and was verified live to actually fail the
  build on a real violation (reintroduced one, confirmed exit 1, reverted).

## Fix

1. Fixed all 17 real findings in `src/router`/`src/server`:
   - Removed genuinely dead code (`ghOpenPrs()` in `multica/backlog.mjs` —
     defined, never called, despite a comment claiming it was kept for
     "potential future direct reuse"; removing it also honors the
     no-pre-emptive-integrations standing rule).
   - Removed an unused local (`out` in `vulcan-hook.mjs`).
   - Simplified 3 useless `runs.length > 0 &&` guards ahead of `.some()`
     (which already returns `false` on an empty array).
   - Simplified 2 useless `{ ...(x || {}) }` fallbacks to `{ ...x }`.
   - Converted 7 genuinely-unused catch bindings to bindingless `catch {}`.
   - Removed/renamed 3 unused test params/vars.
2. Disabled the one real `src/ui` warning inline (`oxlint-disable-line`) at
   the export line with a comment explaining it's the standard shadcn/ui
   `cva()`-export pattern, not something worth restructuring the vendored
   primitive over.
3. Added `oxlint` as a root devDependency + a root `lint` script
   (`oxlint --deny-warnings src/router src/server && npm run lint --prefix
   src/ui`), wired as the FIRST step of `npm run test:all` so it's a real
   part of the standard local verify flow (per the "no GHA gating" standing
   rule — this is a local check, not a new blocking CI step).
4. Added `--deny-warnings` to `src/ui`'s own `lint` script too, for the same
   enforcement everywhere.

## Verification

Manually reintroduced a real violation (an unused catch param) after wiring
`--deny-warnings` and confirmed `npm run lint` exits non-zero, then
reverted — proved the check has real teeth, not just plumbing. Full `npm
run test:all` green throughout (318+52 unit/integration, 8 e2e/hardening).

## Scale

Small-to-medium — many small, independent, low-risk fixes across several
files, but no single fix touches shared logic in a risky way. Design
discussion (this one, informally presented and agreed to before starting)
is sufficient.
