# Design discussion: t010-memory-and-topology

## Goal

Two related additions, both requested together (2026-09-05/06):

1. **Memory adapter** — give Auriga a way to load context/knowledge, with
   Mnemosyne as the concrete provider but a provider-agnostic contract (like
   `BacklogAdapter`/`SpawnAdapter`), so a different provider could be swapped
   in later.
2. **Orchestrator topology registry** — a pure data layer letting one Auriga
   instance be manually registered as another's parent or child, laying
   groundwork for the operator's long-term multi-level orchestration vision
   (a top-level meta-orchestrator, per-project directors, tickets that can
   bounce back up when a lower level gets something wrong) — **without**
   building any of that orchestration/handoff logic itself. Per the
   operator's own framing: "we don't actually create the logic or the setup
   or the orchestration of many levels, we just purely make this as if a
   node in a tree ... when the implementation uses those, it just sets up
   the parts in config correctly."

## Research (real, grounded before designing anything)

- No existing memory integration anywhere in this repo.
- Mnemosyne (sibling repo) already has a proven client contract other
  projects use (`hooks/lib/mnemo-client.mjs`): HTTP service first
  (`POST /recall`, `POST /remember`, default `:8477`), `swarm-memory` CLI
  fallback second, never throws. Built this adapter's real implementation
  directly against that proven shape rather than guessing Mnemosyne's API.
- Checked pantheon-v2's `core-api` live: **no memory-proxy route exists**
  (no `/api/memory`, nothing wrapping Mnemosyne) — only a `persona_root_
  scope_id` field on the tenant registry ("Mnemosyne scopeId for this
  tenant's top-orchestrator persona"), real scaffolding for per-tenant
  memory scoping that nothing yet wires up. This directly validates the
  multi-level vision as already anticipated on the Pantheon side, but
  confirms there is no proxy to route through today.
- This exact situation (a real provider, no Pantheon proxy yet) already
  happened once for Multica: `multica/backlog.mjs` integrated directly,
  then was cut over to `pantheon-v2-l2` once a real proxy existed (PR #65).
  This epic's memory adapter follows that same, now-precedented shape:
  direct-for-now, explicitly flagged as provisional in the code.

## Design: memory adapter

- `lib/adapters/memory-adapter.mjs` — `MemoryAdapter` typedef:
  `recall(query, scope, opts)` / `remember(text, scope, opts)`.
  **Deliberately asynchronous**, unlike `BacklogAdapter`/`SpawnAdapter` —
  those are synchronous because `cycle()` calls them ~25 times and never
  awaits; `MemoryAdapter` has no `cycle()` consumer in this epic (only the
  already-async CLI), and Mnemosyne's real transport is genuinely async.
  Forcing sync here with nothing to justify it would be the same mistake
  the adapters README warns against making to the other two.
- `lib/adapters/mnemosyne/memory.mjs` — real implementation, HTTP-first +
  CLI-fallback-for-recall-only (mirrors `mnemo-client.mjs`'s `recall`
  exactly; deliberately does NOT port its CLI-fallback `remember` path,
  which shells out to `swarm-memory config`/`index` and writes a note file
  under the OPERATOR's home directory — a real side effect this
  router-side adapter should not silently reproduce without its own story).
  `fetch`/`execFile` injected, never imported, matching this codebase's
  established DI convention.
- `lib/adapters/stub/memory.mjs` — in-memory test double, substring-match
  recall, mutate-in-place remember.
- CLI: `auriga memory recall <query> [--scope] [--hits]` /
  `auriga memory remember <text> [--scope] [--tag]`. Scope defaults to
  `AURIGA_TENANT_ID || AURIGA_INSTANCE_ID || 'default'` — reusing this
  week's multi-tenant identity, a natural fit for Mnemosyne's own scope
  concept. `AURIGA_MEMORY_ADAPTER=stub` (+ `AURIGA_STUB_MEMORY_SEED`) lets
  CLI-level tests exercise this with zero live Mnemosyne access, mirroring
  `AURIGA_BACKLOG_ADAPTER=stub`'s established convention exactly.

**Deliberately NOT done this epic:** wiring recall/remember into `cycle()`'s
live dispatch decisions. That is real, separate, higher-risk work (when to
recall, what to do with what comes back, how a remember() call fits into
the per-cycle budget) — better scoped as its own story once this adapter is
proven, not bundled in here.

## Design: orchestrator topology registry

Pure data, mirroring `project-registry.mjs`'s own conventions exactly (same
injected read/write I/O, same env-var path override, same graceful-degrade
contract):

- `src/router/orchestrator-topology.json` — committed default
  `{ parent: null, children: [] }`.
- `lib/orchestrator-topology.mjs` — `setParent`/`clearParent`/`addChild`/
  `removeChild` (all pure functions over plain data) plus the real-file
  read/write pair (`AURIGA_ORCHESTRATOR_TOPOLOGY_PATH` env override for
  test isolation, same convention as `AURIGA_PROJECTS_REGISTRY_PATH`).
- CLI: `auriga orchestrator set-parent <id> [--notes]` / `clear-parent` /
  `add-child <id> [--notes]` / `remove-child <id>` / `list`.

`id` is a free-form, operator-supplied string — not validated, not dialed,
not resolved to a live instance. This registry does not know how to reach
another Auriga instance, does not implement handoff/escalation, and does
not enforce tree well-formedness (e.g. cycles are not detected) — all of
that is explicitly future work, once a real consumer needs it, per the
adapters README's own no-pre-emptive-integrations rule generalized to this
new registry.

## Verification

30 new tests: 9 for the real/stub memory adapters (mocked fetch/execFile,
zero live Mnemosyne access), 12 for the topology registry's pure functions,
6 CLI-level tests for `memory recall/remember` (via `AURIGA_MEMORY_ADAPTER=
stub`), 3 CLI-level tests for the orchestrator subcommands (real spawned
`auriga` process, throwaway topology files, real end-to-end read-back off
disk). Full `npm run test:all` green (360 router tests, up from 330; 52
server; 8 e2e/hardening).

## Scale

Medium — two related but independently-testable new subsystems, following
established adapter/registry/CLI patterns closely; no changes to existing
dispatch decision logic.
