# Design discussion: t004-auriga-redeploy-hook

## Goal

Fix GitHub issue #78: fixes merged to Auriga's `main` never reach a live
pantheon-v2 deployment's running containers, because nothing rebuilds them
after a merge. Real incident already happened: issue #76's fix sat merged
for a long time while `dostal-tech`'s container kept running the pre-fix
image and PANT-4 kept thrashing.

## Research

- pantheon-v2's `docker-compose.yml` and `scripts/generate-auriga-compose.ts`
  build EVERY `auriga`/`auriga-<tenant_id>` compose service's image from a
  plain git checkout at `${AURIGA_LOCAL_PATH:-./plugins/auriga}` — that
  checkout is just a normal clone of THIS repo. So a `git pull` inside it
  is the exact moment a redeploy needs to fire.
- pantheon-v2 already has a proven, working pattern for exactly this shape
  of problem, for its OWN repo: `install/lib/git-hooks/post-merge` (wired
  via `git config core.hooksPath`, not `.git/hooks/` directly, so the hook
  is tracked/reviewable) calls `bin/pantheon-redeploy` when a merge lands on
  `main`. `bin/pantheon-redeploy` already explicitly comments that `auriga`
  is one of its known services (portless, compose-state health-check
  fallback) — it already supports a targeted redeploy of specific services
  by name (`bin/pantheon-redeploy <service> <service> ...`).
- The gap is specifically: nothing in AURIGA's OWN repo triggers that
  existing pantheon-v2 machinery when AURIGA's main (not pantheon-v2's)
  gets new commits.

## Decision

Ship the trigger half of this in Auriga's own repo, mirroring pantheon-v2's
own hook convention exactly (same wiring mechanism, same guard-on-main
logic) rather than inventing a new pattern or asking pantheon-v2 to grow
per-plugin logic for every god it hosts. Zero changes needed to pantheon-v2
— it already has everything this hook calls.

**Standalone-safety is the central design constraint.** Auriga is cloned
far more often as an ordinary standalone dev checkout (no pantheon-v2
parent at all — this session's own working copy is one) than as a real
nested deployment checkout. The hook must be a correct, silent, documented
no-op in the standalone case: detect whether a real pantheon-v2 deployment
tree exists two directories up (a `docker-compose.yml` referencing
`AURIGA_LOCAL_PATH` + a working `bin/pantheon-redeploy`) before doing
anything, and never hardcode pantheon-v2-specific state (tenant names,
service counts) — discover live `auriga*` services via
`docker compose config --services` instead, so the hook never needs
updating as tenants are added/removed.

Per issue #78's explicit ask, also documented the manual fallback command
sequence in the README, independent of the hook.

## Verification

Manually exercised all three real branches of the hook's logic (not just
read the code):
1. Standalone checkout (no pantheon-v2 parent) → silent no-op, exit 0.
2. Nested under a real (temp, disposable) pantheon-v2-shaped tree, on
   `main`, with a real `docker compose config` call against a real Docker
   daemon → correctly discovered the `auriga` service and invoked
   `bin/pantheon-redeploy` with it.
3. Same nested tree, multi-tenant (`docker-compose.override.yml` adding
   `auriga-dostal-tech`) → correctly discovered BOTH services, excluded an
   unrelated `core-api` service.
4. Nested tree, but on a feature branch (not `main`) → no-op, exit 0.

Found and fixed one real portability bug during this verification:
`mapfile` (a bash-4+ builtin) isn't available under this machine's default
`bash` (macOS ships bash 3.2) — replaced with a portable `while read` loop
before it could bite a dev machine or an unexpectedly-old deploy host.

## Scale

Small — one new shell script + a README section, zero changes to router
code or any existing test suite. Design discussion is sufficient.
