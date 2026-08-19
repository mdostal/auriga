# Design Discussion: Standalone Project Registry

## 0. Prelude

**NORTH STAR** (from `.pHive/project-profile.yaml`):
Goal: Auriga becomes a generic, standalone top-level orchestrator with pluggable
backlog/spawn adapters — no direct external-system coupling.
Audience: the operator, running many concurrent sessions across many unrelated
projects, wanting Auriga as the top-level dispatcher above all of them.

This epic serves north_star directly and closes a gap north_star's own prior epic left
open: `config-substrate.mjs`'s own "KNOWN GAP" comment (written during
`p1-router-capability-routing`) explicitly says unmapped projects need "reconciliation
with Minerva/operator before this part of the epic can be completed" — this epic is
that reconciliation mechanism, turning a hand-edited source file into a real,
operator-driven registry.

## 1. What Are We Doing?

Operator's explicit framing (verbatim, not re-derived): Auriga running standalone needs
its own metadata and knowledge of how to orchestrate each registered project —
generated and owned by Auriga itself, right now, not routed through Mnemosyne or any
sibling god. "When we plug in WITH auriga, it will use and generate that doc for you —
before that, or solo, you are the orchestrator and get to get a set of metadata and
info for how you orchestrate."

Three pieces:
1. **`auriga project scan`** — discover what's out there to register (Multica's real
   project list), presented as candidates, never auto-registering anything.
2. **`auriga project add`/`remove`/`list`** — real, deliberate operator actions that
   replace hand-editing `config-substrate.mjs`'s `PROJECT_NAMES`/`PROJECT_IDS`.
3. **Freeform notes per project** — Auriga's own local, standalone "base level memory"
   of a project, attached at `add` time or any time after.

"Done": the operator can register/deregister a project via the CLI instead of editing
source, `scan` shows real candidates from the live board, notes persist and are
retrievable, and — critically — nothing about `auriga-router.mjs`'s actual dispatch
behavior changes for already-registered projects (this is a storage/interface change,
not a routing-logic change).

## 2. What I Found

Research (grounded in real file reads, not assumption — see `research-brief.md`)
surfaced one thing that materially shapes scope: **`PROJECT_NAMES` is purely cosmetic**
(always has a safe raw-UUID fallback), but **`PROJECT_IDS` is the actual dispatch-
eligibility gate** — a project missing from it is silently excluded from real
dispatch/cascade, and its order determines dispatch priority. `PROJECT_LANE` already
degrades safely to `DEFAULT_LANE` when a project is unmapped. This means the registry's
core job is replacing `PROJECT_IDS` (and, cosmetically, `PROJECT_NAMES`) — not
`PROJECT_LANE`, which can stay a separate, still-hand-edited routing-policy concern
without breaking anything (see Open Question 3).

Also found: `listAllProjectIds()` returns bare IDs only — the real Multica CLI call
(`multica project list --output json`) almost certainly returns richer objects, but the
current code discards everything but `.id`. A `scan` that shows real names needs a new
adapter method — but this codebase already has an established, non-speculative pattern
for exactly this (`listAllIssues`/`listCandidatePullRequests` — "ported extras," not in
the strict typedef, presence-checked by callers), so this isn't a new architectural
concept, just applying an existing one.

And: no existing precedent for a gitignored, machine-local state directory anywhere in
this repo (grepped — one real file write exists total, a `/tmp`-defaulting PID file).
The closest real precedent for "operator-extensible list" is `HUMAN_NAMES` — committed,
hand-edited source. Combined with `PROJECT_IDS` being genuinely shared/portable
dispatch-gating state (not personal-machine-only, unlike an MCP registration), this
points toward a committed config file, not a dotfile.

## 3. My Proposed Approach

**Slice 1 — `listAllProjects()` ported-extra adapter method.** Add to the real Multica
backlog adapter implementation only (mirroring `listAllIssues`'s presence-check
pattern): returns `{id, name}` pairs by keeping the fields `listAllProjectIds()`
currently discards. Not part of the strict `BacklogAdapter` typedef — an adapter without
it (e.g. a future stub) simply doesn't support name-enriched scan results, degrading to
ID-only. Needs a real call against the live Multica CLI to confirm the actual field name
for "name" in the JSON response (`p.name`, `p.title`, etc. — not yet confirmed by static
reading alone).

**Slice 2 — The registry itself.** A new `src/router/lib/project-registry.mjs`
(mirroring `agent-setup.mjs`'s injected-dependency shape for testability) backed by a
new committed JSON file (e.g. `src/router/projects.json`) holding an ordered list of
`{id, name, notes, registered_at}` entries. `config-substrate.mjs` is refactored to
derive `PROJECT_NAMES`/`PROJECT_IDS` from this file at import time instead of hardcoded
object literals — every existing consumer in `core.mjs`/`auriga-router.mjs` needs ZERO
changes, since they only ever read the exported `PROJECT_NAMES`/`PROJECT_IDS` values,
never the literal syntax that produces them. This is the single highest-leverage design
choice in this epic: it makes the registry a pure storage-and-interface change, not a
routing-logic change, which is what "Done" (§1) requires.

**Slice 3 — CLI: `auriga project scan`/`add`/`remove`/`list`.** New dispatch branches
in the existing `bin/auriga.mjs` (no new bin entry needed), calling into
`project-registry.mjs`. `scan` calls `listAllProjects()` (falling back to
`listAllProjectIds()` + raw-ID display if the adapter lacks the ported extra) and
diffs against the registry, showing unregistered candidates — read-only, no mutation.
`add <id> [--name ...] [--notes ...]` appends to the registry (validated against a
fresh scan so a typo'd ID doesn't silently register nothing). `remove <id>` deletes the
entry (and, if present, its `PROJECT_LANE` entry — see Open Question 3). `list` reads
and displays the registry, read-only.

**Slice 4 — Notes update.** A way to attach/update notes on an already-registered
project without a full remove+re-add — likely `auriga project notes <id> "<text>"` or
folded into `add` being idempotent (re-running `add` on an existing ID updates its
name/notes rather than erroring) — exact shape is Open Question 4.

## 4. What Could Go Wrong

- **Medium — the `listAllProjectIds()` → `PROJECT_IDS` refactor touches the dispatch-
  eligibility gate directly**, per research's own finding. A bug here doesn't just
  break a cosmetic feature, it could silently exclude or wrongly include a project from
  real dispatch. Mitigation: Slice 2's own acceptance bar must include a real
  before/after diff — the derived `PROJECT_IDS` array from the new registry, loaded
  with today's actual 4-entry hardcoded list migrated in as the registry's initial seed
  data, must be byte-identical in order and content to the current hardcoded array, and
  `core.mjs`'s existing dispatch-ordering tests must stay green unchanged. **Revised per
  grill H3 (rollback path was unnamed): if this verification fails, the migration
  blocks — Slice 2 is not done, ship is blocked, and the mismatch is diagnosed and
  fixed before anything merges. This is a hard merge gate, not a soft warning.**
- **Medium (raised per grill H2) — reading a JSON file at ESM top-level import time is
  a genuinely new pattern in this codebase, not a risk-free mechanical detail.** Grepped
  — zero existing top-level `readFileSync` anywhere in `src/router/lib/*.mjs` outside
  test files. Critically, `spawn-adapter.test.mjs` directly imports `PROJECT_LANE`
  etc. from `config-substrate.mjs` — after this refactor, THAT test (unrelated to the
  registry feature) would fail to even load the module if the new registry file is
  missing or malformed, a new failure mode for existing, unrelated tests. Mitigation:
  the import-time read must degrade gracefully — a missing/malformed registry file
  logs a loud warning and falls back to an empty project list (matching this codebase's
  existing degrade-gracefully convention, e.g. `listAllProjectIds()`'s own
  try/catch-and-return-`[]` shape), never throws and crashes module load. This must be
  a real, tested behavior (a test asserting the module still loads with a missing
  registry file), not just an assumption.
- **Medium — the real Multica project object's field names for name/description are
  not yet confirmed.** Slice 1 needs a real, live `multica project list` call (not just
  static code reading) before implementation — flagged explicitly so it doesn't get
  built against a guessed field name.
- **Low — migrating existing `PROJECT_NAMES`/`PROJECT_IDS` entries into the new
  registry file is a one-time data migration**, not itself new logic, but needs to be
  done correctly. **Revised per grill H1**: the "4 active, 13 deferred-to-scan" framing
  in Open Question 2 (below) undersold this — MINERVA is in `PROJECT_NAMES` but not
  `PROJECT_IDS`, YET it IS one of `PROJECT_LANE`'s 5 hardcoded entries, pinned by
  `spawn-adapter.test.mjs`'s explicit "exactly 5 mapped project UUIDs" assertion. It is
  excluded from dispatch but load-bearing in routing policy — not inert like the other
  ~12 unmigrated names. See Open Question 2's revision below.
- **Low (named per grill H4, not previously addressed) — concurrent-write/hand-edit
  risk on the committed registry file.** A single operator hand-editing the JSON file
  while a `auriga project add` invocation is also mutating it, or two terminals running
  `add` back-to-back, could clobber a write. Explicitly accepted as low-probability and
  out of scope for this epic (single-operator CLI tool, not a multi-writer service) —
  named here so it's a deliberate, recorded decision rather than an unconsidered gap.
- **Low — scope creep toward "also manage PROJECT_LANE."** Explicitly named as Open
  Question 3, not assumed either way.

## 5. Dependencies and Constraints

- `adapter-boundary-integrity` cross-cutting concern applies directly (triggered by
  touching `config.mjs`, per its own `applies_when`) — walked here: Slice 1's new
  adapter method follows the established ported-extra pattern (not a typedef change);
  Slice 2's registry itself is pure local state with no external call. **Revised per
  grill U1**: the earlier framing that this epic "removes hardcoded values... satisfying
  the checklist directly" overclaimed — `projects.json` is itself static data until the
  CLI mutates it, so this *relocates* hardcoding from a `.mjs` literal into a smaller,
  operator-mutable JSON surface; it doesn't eliminate hardcoding as a category. That's
  still a real improvement (the values become CLI-editable instead of requiring a code
  change) but "relocates," not "removes," is the accurate framing for the epic record.
- "No pre-emptive integrations" (`lib/adapters/README.md`) applies directly to the
  operator's own explicit constraint: no Mnemosyne/pantheon-v2-l2 hook, adapter method,
  or field is added in this epic. If a future need arises to gesture at that boundary
  at all, `lib/adapters/pantheon-v2-l2/`'s existing throw-`NotImplementedError` stub
  pattern is the established shape to mirror — not built here regardless.
- Local validation is the gate (documented in `.pHive/CONTEXT.md` since
  `p4-auriga-branding`'s closeout) — this epic's verification must include a real,
  live `multica project list` call (Slice 1) and a real before/after `PROJECT_IDS`
  diff (Slice 2), not self-reported.

## 6. Open Questions

1. **Registry file location/name** — `src/router/projects.json` (sibling to
   `package.json`), or somewhere under `lib/`? My lean: sibling to `package.json`,
   parallel to how `agent-setup.mjs`'s harness registrations are a router-level
   concern, not buried in `lib/adapters/`.
2. **Revised per grill H1 — migration of the 17 existing `PROJECT_NAMES` entries is
   NOT a clean "4 active / 13 inert" split.** MINERVA is in `PROJECT_NAMES` but not
   `PROJECT_IDS` — yet it IS one of `PROJECT_LANE`'s 5 hardcoded entries, pinned by an
   existing test's exact-count assertion. So the real question is: migrate only the 4
   `PROJECT_IDS` entries (leaving MINERVA to `scan`, same as the other ~12, even though
   it's routing-policy-load-bearing elsewhere), or migrate the 4 PLUS any project ID
   that appears anywhere else in `config-substrate.mjs` (i.e. also in `PROJECT_LANE`,
   currently just adding MINERVA to the migrated set)? My lean: migrate the 4 PLUS
   MINERVA (5 total) — since `PROJECT_LANE` stays out of this epic's scope regardless
   (Open Question 3), MINERVA's presence there doesn't change its dispatch-eligibility,
   but registering it in the new registry (even without adding it to the derived
   `PROJECT_IDS` set) avoids `scan` perpetually flagging a project the routing table
   already knows about as if it were wholly undiscovered. This is a real judgment
   call, not obvious either way.
3. **Is `PROJECT_LANE` (agent-lane assignment) in scope for this epic?** My lean: no —
   it already degrades safely to `DEFAULT_LANE` when absent, and the operator's own
   framing was about project identity + notes, not routing policy. Keep it a separate,
   still-hand-edited concern; note this explicitly rather than silently expanding
   scope.
4. **Notes-update command shape**: a dedicated `auriga project notes <id> "..."`, or
   make `add` idempotent (re-add updates name/notes)? My lean: idempotent `add` — one
   fewer command to remember, and matches `agent init`'s own idempotency precedent from
   p5.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: node:test (registry logic, injected-fs pattern matching agent-setup.test.mjs),
    a real live `multica project list` call (Slice 1, to confirm actual field names)
  Platforms: this machine's real Multica CLI
  Automated: full existing suite must stay green — CRITICALLY including:
    (a) a new explicit test asserting the migrated PROJECT_IDS array is byte-identical
        in order/content to today's hardcoded 4-entry array (the dispatch-eligibility-
        gate risk named in §4) — failure BLOCKS ship, no silent fallback (grill H3)
    (b) src/router/test/spawn-adapter.test.mjs named EXPLICITLY (grill U2, not folded
        into "full suite stays green") — its deepEqual(lanes.projectLane, PROJECT_LANE)
        and exact-5-key-count assertions against config-substrate.mjs's REAL (non-
        fixture) exports must still pass unchanged after Slice 2's refactor
    (c) a new test asserting config-substrate.mjs still loads successfully (does not
        throw) when the registry file is missing or malformed, degrading to an empty
        project list with a logged warning (grill H2 — this is a genuinely new failure
        mode for an unrelated existing test that imports this module)
  Manual: a real `auriga project scan` run against the live board, a real
    add/list/remove cycle, confirming notes persist across process restarts (read the
    file back, don't just trust in-memory state)
  Not verifying: PROJECT_LANE / agent-lane assignment (out of scope, Open Question 3);
    concurrent-write safety on the registry file (accepted low-probability risk, grill
    H4 — single-operator CLI, not a multi-writer service)
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: config-substrate.mjs (refactored, not rewritten), a new
    lib/project-registry.mjs, a new committed projects.json, a new "ported extra"
    method on multica/backlog.mjs, new CLI dispatch branches in bin/auriga.mjs
  Subsystems: one new local-state concept (the registry file) layered onto existing
    adapter/CLI patterns — no new subsystem class the way p5's MCP server was
  Migration required: yes — a one-time, low-risk-if-verified-correctly data migration
    of the existing hardcoded PROJECT_IDS/PROJECT_NAMES into the new file
  Cross-team coordination: no
  Unknowns: 4 open questions above; Slice 1's real field-name confirmation is the one
    genuine "must verify against live system before finishing" unknown

  RECOMMENDATION: Medium scope — multi-file, crosses the adapter/CLI/config layers,
  and touches a real dispatch-eligibility gate (not a cosmetic change). Proposing to
  use the 4 vertical slices in §3 directly as the story decomposition basis (same
  approach p5-agent-mcp-integration used successfully) rather than separate formal H/V
  documents — each slice already leaves the product in a working, tested state.
```
