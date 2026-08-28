# pantheon-v2-l2

This is the **ONLY sanctioned path from Auriga to Pantheon**. Auriga must
never call Minerva, Consus, or any other Pantheon-side system directly — if a
future story needs Auriga to talk to Pantheon, it talks through this adapter,
not around it.

`index.mjs` exports `createPantheonV2L2BacklogAdapter()` and
`createPantheonV2L2SpawnAdapter()`, implementing the `BacklogAdapter` (see
`../backlog-adapter.mjs`) and `SpawnAdapter` (see `../spawn-adapter.mjs`)
shapes exactly like every other adapter in this directory — plain factory
functions, no class, frozen object literals.

## Real, as of the pantheon-owns-multica-board-bridge epic

This adapter is no longer a stub. Both factories are real implementations
calling Pantheon's own backlog API (`core-api`'s `core/api/backlog.ts` in the
`pantheon-v2` repo), which itself wraps Multica's real REST API. This closes
a real, standing architecture violation: `multica/backlog.mjs` and
`multica/spawn.mjs` (this directory's siblings) integrated directly with
Multica via its native CLI binary — the operator's explicit, repeated
correction was "auriga asks the pantheon for tickets, the pantheon gives it
to auriga -- NO ONE INTEGRATES DIRECTLY TO MULTICA." Separately (but for the
same underlying reason), that CLI binary is a native macOS Mach-O executable
that cannot run inside this container at all — confirmed empirically broken
here, not assumed.

**Transport:** every method stays synchronous (unchanged contract — see
`../backlog-adapter.mjs` / `../spawn-adapter.mjs`), achieved the same way the
`multica/` adapters achieved it: a real, blocking `execFileSync` call, just
against `curl` hitting Pantheon's HTTP API (`./http-runner.mjs`) instead of
the `multica` CLI binary. `curl` is a standard Linux package (installed via
`apk add curl` in `pantheon-v2`'s `Dockerfile.auriga`), unlike a native macOS
binary — that is the concrete fix for the container-can't-execute-the-binary
half of the original problem, alongside the architectural fix (no direct
Multica integration at all) for the other half.

**Credential boundary:** this container holds zero Multica credentials, runs
no Multica CLI, and has no direct network path to Multica — only network
access to `core-api` (`PANTHEON_API_URL`, defaulting to
`http://core-api:3012`, matching docker-compose's internal hostname). Only
`core-api` itself ever holds a real Multica PAT.

**Known, deliberate scope boundaries** (see `index.mjs`'s own comments for
the full reasoning on each):

- `listAllProjectIds()` returns a single sentinel value rather than real
  Multica project ids — Pantheon's backlog API is deliberately board-wide,
  not project-scoped, so this adapter never needs (or leaks) Multica's
  project concept. `listAllIssues()` does one full, board-wide scan
  regardless of what it's passed.
- GitHub-based PR discovery (the old `multica/backlog.mjs`'s
  `listCandidatePullRequests`/`ghPrs`/`ghListRepos`) is **not** ported here —
  that is a separate integration (GitHub, not Multica), out of scope for
  this epic. `auriga-router.mjs`'s cycle() already duck-types for its
  absence and falls back to per-identifier `getIssuePullRequests`, which
  this adapter does implement (Multica's own native PR linkage only).
- Issue objects returned by this adapter are mapped back to the exact raw,
  snake_case field shape (`assignee_id`, `project_id`, `parent_issue_id`,
  ...) that `lib/core.mjs` already reads directly — not the cleaner,
  camelCase shape Pantheon's own `BoardQueue` port uses internally. Auriga's
  real consumer code was never actually backend-agnostic in practice despite
  the adapter interface's own aspiration to be one; this adapter preserves
  that existing shape rather than silently changing it.

## Building further real integrations

The precedent above — this file's own real implementation — is the template
for any FUTURE Auriga-to-Pantheon integration: it still goes through this
adapter (never around it), and any new Pantheon-side capability gets exposed
here the same way the backlog/spawn surface was. This is not itself grounds
to add speculative methods ahead of a real, concrete need — see
`../spawn-adapter.mjs`'s own "no provisioning method of any kind" rule, which
still applies.
