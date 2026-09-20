# t015: orchestrator hand-up logic

## REVISION 2026-09-06 — operator design conversation, superseding most of the below

Three real corrections from the operator during review materially changed this epic's
shape from the original draft (kept below for its research value, but the "Proposed
implementation shape" section below is now stale — see the new one at the bottom of this
revision block):

1. **"auriga's job is moving tickets and assigning -- forcing that to another board is
   100% within that assignment... it cannot have to read OTHER boards as well -- moving
   it up is 100% auriga's job."** The original draft proposed a conservative
   comment-and-park action (option ii below), deferring the actual cross-board move to a
   human. Wrong: a real WRITE to another board, on-demand, one ticket at a time, is
   exactly the same category of action Auriga already performs (assign, comment,
   setStatus) — just targeting a different board. It is not a new "integration" the
   "no pre-emptive integrations" rule should gate; that rule is about not
   reading/polling/dialing systems Auriga has no current need to consume, not about
   avoiding writes that are its actual job. Auriga must never need to READ/poll another
   board's live state, but a one-shot WRITE (create a ticket there) is in scope.
2. **"IF there is no knowledge OR no where to move it up to -- 100% -- human job."**
   Clean fallback: Auriga only performs a cross-board move when a real destination is
   configured. No registered parent (or, symmetrically, no matching child mapping) →
   falls to the existing human-todo path — Auriga never invents a destination or leaves a
   ticket in limbo.
3. **"if this ticket doesn't seem to fit anything I have access to -- force it back up
   and if there's a board above, it should be able to continue to figure that or continue
   to hand up"** + the follow-up describing the real multi-level topology (per-project
   "meta orchestrators" at e.g. Dostal Tech / Firefly / Personal level, mostly handing
   directly to the right repo/runner; a hypothetical top-level "meta of everything"
   orchestrator that only needs to know its own children and hands a ticket down to the
   right child's board, e.g. "make a ticket for Firefly Events' Flayr app" → fires it into
   Firefly Events' own board and lets THAT instance's own Minerva/architect/runners take
   it from there). Two structural consequences:
   - **Hand-up is recursive by construction, with zero new "multi-level" code.** Every
     instance runs the identical local rule against its OWN `topology.parent`. If a
     parent also can't route a handed-up ticket and has its own parent, ITS next cycle
     hands it up again automatically — recursion falls out of the tree shape, not out of
     any code this epic writes.
   - **Hand-down is the SAME shape as hand-up, and also the same shape as today's
     existing `PROJECT_LANE` routing** — "which child owns this project" is structurally
     identical to "which agent lane owns this project," just with a different kind of
     target. It reuses the same underlying cross-board-write primitive hand-up needs,
     parameterized by a *child* topology entry instead of the single parent.

### Scope decision: split into two epics sharing one primitive

Given the real size this now has (a new cross-board write capability + two schema
extensions + two routing changes), split rather than build all of it as one unverified
unit:

- **t015 (this epic): the shared primitive + hand-UP only.** One parent, no selection
  ambiguity, explicit-label-triggered, recursive by construction. This is the "call it
  good for now" scope from the operator's original ask.
- **t016 (immediate next epic, not blocking t015, not started yet): hand-DOWN.** Reuses
  t015's cross-board-write primitive; adds a `PROJECT_LANE`-style routing-table extension
  so a project can resolve to `{ kind: 'child', childId }` instead of `{ kind: 'agent',
  lane }`. Explicitly captured here and in `VISION.md` so it isn't lost, not silently
  dropped.

Explicitly OUT of scope for both t015 and t016: a new "talk to the top orchestrator to
originate a ticket" intake surface (that's ticket *origination*, a different feature from
ticket *routing*, and the real design questions there — does a top-level orchestrator
even have its own board, or does it work from pure conversational input? — are
substantial enough to deserve their own future epic, not a rider on this one).

### Revised concrete shape (supersedes the "Proposed implementation shape" section below)

- **New `BacklogAdapter` capability**: `createIssue(ticketInfo)` — a genuinely new method
  (no adapter implements ticket creation today; every existing method acts on an EXISTING
  issue). **Confirmed live 2026-09-06** (cross-session peer `pantheon-v2-6e`, read
  directly from `core/api/backlog.ts` lines 165-185, not guessed): `POST
  /api/backlog/issues` is real and already exists. Body: `{ title (required),
  description?, status?, labels?, metadata?, parent?, project? }` — note the field is
  `project`, not `project_id` (matches the BoardQueue port's own naming, not Multica's raw
  field name — same naming mismatch class as every other `toRawIssue()`-mapped field in
  this adapter). Response: `201` with the created issue on success, `502` with
  `{error: message}` on any backend failure; the handler is a thin passthrough
  (`getBoard().create(request.body)`), no auth/validation beyond the required-title check.
  The created-issue response gets passed through the file's existing `toRawIssue()` mapper
  so `core.mjs` sees the same snake_case shape it already expects everywhere else in this
  adapter. A `multica`-CLI equivalent (`multica issue create`, if the CLI supports it — to
  be confirmed during implementation, not blocking this design) mirrors it for parity,
  matching every other dual-implementation in this adapters directory.
- **Topology schema, extended per the operator's "both, combined" answer**: since
  `createPantheonV2L2BacklogAdapter(cfg)` already takes exactly `{ baseUrl, project, ... }`
  (confirmed: `index.mjs` line ~117), reaching the parent's board needs no new adapter
  TYPE — just a second instance of the SAME existing adapter, pointed at the parent's
  `baseUrl`/`project` instead of this instance's own. Two ways to supply that pair, both
  wired in (the operator's "both, combined" answer):
  1. `orchestrator-topology.mjs`'s `setParent()`/`addChild()` gain optional `baseUrl`/
     `projectId` fields, stored directly in `orchestrator-topology.json` alongside
     `id`/`notes`.
  2. `AURIGA_CONFIG`'s existing per-tenant JSON override file (already used for
     `CAPS`/`PROJECT_LANE`/etc. per `config-loader.mjs`) may instead carry a
     `parentBoard: { baseUrl, projectId }` block, letting an operator manage a tenant's
     parent-reachability config in the SAME file they already maintain per tenant,
     without duplicating it into `orchestrator-topology.json`.
  Resolution order: `AURIGA_CONFIG`'s `parentBoard` block (if present) wins, else fall
  back to `topology.parent`'s own `baseUrl`/`projectId` fields; if NEITHER supplies both
  fields, there is no real destination — hand-up falls to the human-todo path (per the
  operator's "no knowledge or nowhere to move it -- 100% human job").
- **`isHandUp(issue)`**: unchanged from the original draft — an explicit label
  (mirrors `isSeed()`'s label-normalization handling), the judgment call staying outside
  the router.
- **`selectAssignments` routing order, t015 slice only**: existing hive/seed checks
  unchanged → existing local PROJECT_LANE/DEFAULT_LANE dispatch unchanged → NEW: if
  nothing above matched, the ticket carries the hand-up label, AND `topology.parent` is
  configured with real reachability → `createIssue` on the parent's board, then locally
  `commentOnIssue` (linking to the new ticket) + `unassignIssue` + `setIssueStatus`
  (closed/cancelled — never silently left as a phantom `todo`) + `logImpl('hand_up',
  ...)`. If the label is set but no parent (or no reachability config) exists → existing
  human-todo path, unchanged mechanism.
- Real, since-confirmed-necessary new test surface: cross-board `createIssue` call
  correctness (right target, right payload) for at least one real adapter; the
  no-parent/no-reachability → human-todo fallback; the label-set-but-nothing-else-matched
  ordering (hand-up must never preempt a normal, resolvable local dispatch).

---

## Original draft (2026-09-06, pre-revision) — kept for research context only

## Goal

`t010-memory-and-topology` (shipped) built `orchestrator-topology.json` — a plain
`{ parent: {id, notes}|null, children: [...] }` tree node, wired by hand via
`auriga orchestrator set-parent/add-child/...`. It is **pure data on purpose**: no
orchestration logic was built on top of it. This epic is that first piece of real logic:
when a running instance has a registered `parent`, give it a way to **hand a piece of
work back up** to that parent instead of churning on it forever — the up-direction only,
per the operator's own framing ("we'll call it good for now after we have that fully
implemented").

## Precedent this mirrors

The router already has exactly one "this isn't mine to build, hand it to whoever's job
it actually is" pattern: `isSeed()`'s routing in `selectAssignments` (`core.mjs`). An
unplanned, childless, top-level ticket is never dispatched to a build lane — it's routed
to the `minerva-dev` planning lane instead, and if that lane has no capacity, the router
skips it that cycle rather than falling back to a normal lane. Hand-up should be the same
shape: a pure predicate identifies "this belongs above me," and a routing branch acts on
it — not a new async subsystem.

## Open question 1: what triggers a hand-up?

Three candidates, evaluated against real router facts (not guessed):

- **(a) Project scope mismatch** — a ticket whose `project_id` isn't in this instance's
  own `PROJECT_IDS`/`PROJECT_LANE` at all. Structurally the closest match to `isSeed()`'s
  shape (a pure property of the issue, decidable with zero new I/O). **The real problem:**
  `selectAssignments`'s own candidate pool is *already* filtered to
  `cfg.PROJECT_IDS.includes(i.project_id)` before any routing decision runs (see
  `core.mjs`, the `candidates` filter chain) — an out-of-scope ticket is invisible to this
  instance's board scan by construction. It never reaches a place where a hand-up
  predicate could fire. Using this trigger would mean either loosening that filter (real
  behavior change to an unrelated, working invariant) or scanning a *second*, wider board
  view just to notice tickets to hand away — meaningfully more scope than "hand back up."
- **(b) Explicit label** — mirrors `not-a-seed`/`idea`/`needs-plan` driving `isSeed()`
  exactly: a human or Minerva applies e.g. `hand-up` (or `escalate`) to a ticket this
  instance is already scanning (it's in scope, in the candidate pool) but has decided —
  for whatever domain reason — isn't this instance's to resolve. Zero filter changes,
  zero new board-scan surface, same shape as the existing precedent, and the decision of
  *when* to apply the label stays entirely a human/Minerva call, not something Auriga's
  router guesses at.
- **(c) Other board signals** (repeated failure, zombie-give-up exhaustion) — real, but a
  materially different feature (an automatic escalation-on-failure policy, not "hand
  back up on request"). Worth a future epic on its own; conflating it with this one risks
  scope creep the operator explicitly warned against ("we'll call it good for now").

**Recommendation: (b), the explicit label**, for the reasons above — it's the only one of
the three that doesn't require touching the existing candidate-pool filter or inventing a
new scan surface, and it keeps the *judgment call* ("is this actually not mine") outside
the router, exactly where `isSeed()` already keeps it.

## Open question 2: what does "handing up" concretely DO?

There is **zero live communication path between two Auriga instances anywhere in this
codebase today** (confirmed by search — no HTTP client/server code for this, no queue,
nothing that could carry a real cross-instance call). The topology registry's `parent.id`
is a free-form operator string (a tenant id, a URL, a hostname — whatever a *future*
consumer resolves); `orchestrator-topology.mjs`'s own header comment is explicit that it
does not dial, discover, or validate reachability of any kind. Three honest options:

- **(i) Structured JSONL log event only** — `logImpl('hand_up', { identifier, parent: topology.parent.id, reason })`,
  using the exact same `logImpl(event, payload)` convention every other router decision
  already uses (`advance`, `cascade_dispatch`, `assign_error`, etc.). Zero new transport,
  zero board mutation. Downside: only visible in *this* instance's own local logs — a
  human (or a future log-shipping pipeline) has to be watching.
- **(ii) Write onto the issue itself** — `backlog.commentOnIssue(identifier, "...")` (already
  a real method on every `BacklogAdapter` implementation, used elsewhere for zombie
  give-up) plus removing/changing the instance's own claim on it (e.g.
  `unassignIssue` — also already real) so it stops being dispatched here every cycle.
  Still no live call to the parent, but it *does* mutate shared board state that a human,
  or later a real parent-side poller, can see without needing this instance's own logs.
- **(iii) An actual live call to the parent** — requires resolving `parent.id` into
  something reachable, which the topology registry deliberately does not do. This is a
  new integration with a system that doesn't exist as a callable target yet — squarely
  the "no pre-emptive integrations" rule. **Recommend explicitly ruling this out for this
  epic.**

**Recommendation: (ii)**, layering on top of (i) (do both — log the decision the same way
every other decision is logged, AND make the hand-up visible on the board itself via a
comment). This gives a real, useful, self-contained behavior — the ticket visibly stops
being this instance's problem — without inventing any new transport or guessing at how a
parent instance would ever consume it. (iii) is out of scope.

## Open question 3: scope confirmation

Per the operator's own "we'll call it good for now after we have that fully implemented"
— this epic is **only** the up-direction against an explicit per-issue signal:

- IN scope: a pure predicate (`isHandUp(issue)`, mirroring `isSeed()`'s label-check shape)
  + a routing branch in `selectAssignments` that, when `topology.parent` is set and the
  candidate carries the hand-up label, comments + unassigns instead of dispatching to a
  lane, and logs the decision.
- OUT of scope (explicitly, not silently dropped): hand-down (parent→child), any
  discovery/validation of the parent's reachability, any bidirectional negotiation
  protocol, automatic hand-up on failure/exhaustion (candidate (c) above), and touching
  `isSeed()`/`minerva-dev` routing itself.

## Proposed implementation shape (pending sign-off)

- `core.mjs` (or a new tiny leaf module, matching the t011 decomposition convention if it
  turns out cleaner) gains `isHandUp(issue)`: checks for a `hand-up` label, mirroring
  `isSeed()`'s label-normalization handling (`multica issue list` returns label objects,
  not strings).
- `selectAssignments` gains a branch, checked before the normal
  `chooseAgentForProject` path (same position `isSeed()`'s branch occupies today): if
  `isHandUp(issue) && topology.parent`, comment + unassign + log `hand_up`, and exclude it
  from `chosen` (never dispatch it locally).
- The topology data (`orchestrator-topology.mjs`'s `loadRealTopology()`) is read once per
  cycle in `auriga-router.mjs`, same pattern as every other config read, and passed into
  `selectAssignments` as a new, explicit parameter — not a hidden import inside
  `core.mjs` (keeping `core.mjs` a pure function of its inputs, per its existing
  convention).
- No new adapter method: `commentOnIssue`/`unassignIssue` already exist on every real
  `BacklogAdapter`/`SpawnAdapter` implementation.

## Risks

- **Silent no-op if the label convention is never actually used.** Same risk profile as
  `isSeed()`'s own label-driven design — mitigated the same way: document the label in
  `README.md`/an agent-instructions file so a human or Minerva knows to apply it.
- **A ticket with no registered parent carrying the label** — must be a safe no-op (stays
  in the normal candidate pool, dispatched normally), not a silent black hole. Will be a
  named acceptance criterion + test case.
