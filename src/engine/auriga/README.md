# auriga — our default orchestrator implementation
Satisfies the /contracts interfaces. Swappable (Don/community can plug their own).
Built by lifting the plugin-hive spine (DAG executor + cycle-reconciler).

## Implementations

- `auriga/lock/` — the first real `LockContract` implementation, backed by
  the live Multica issue API. Multica has no native claim/lease/sweeper
  endpoint (see
  `.pHive/epics/contracts-and-spine/docs/multica-lock-api-findings.md`), so
  claim/renew/release/sweep are built entirely client-side on top of plain
  issue `PUT`s: a read-then-conditional-write claim with an in-process
  per-taskId mutex (deterministic for same-instance races, best-effort for
  cross-instance ones — Multica gives no compare-and-swap), a synthetic
  client-tracked lease with no server-side TTL, and a poll-based sweep
  scoped to leases this instance itself claimed. See the class doc comment
  in `auriga/lock/index.ts` for the full rationale.

- `auriga/watcher/verification-swarm.ts` — `VerificationSwarmDispatcher`,
  reacting to `BoardStateWatcher`'s `"review-eligible"` event
  (`auriga/watcher/index.ts`) by creating N staged sub-issues under the
  review-eligible issue as parent, each `stage: 1`, each assigned to a
  distinct verifier, via Multica's native staged sub-issue barrier
  (`--parent`/`--stage` on `multica issue create`). Creation-only: does not
  read verdicts back (that's the dependent verdict-synthesis-escalation
  story) and never writes to the parent issue itself, so the parent's own
  status is left untouched.

  **Verifier count N and assignee selection**: `verifierPool` (an array of
  `{id, type}` Multica assignee entries) is required constructor config,
  with no baked-in default. `N` defaults to `verifierPool.length` — every
  configured verifier gets exactly one sub-issue, which makes "N sub-issues
  with distinct assignees" true by construction rather than a separately
  reconciled invariant. The live Auriga pool is centralized in
  `auriga/watcher/verifier-pool.ts` and currently contains two dedicated
  Multica agent identities provisioned for this project: `auriga-verifier-a`
  (`d2097159-285c-43b8-86c7-4a2a5cb1d5d9`) and `auriga-verifier-b`
  (`25238152-6c2f-4959-bd05-7e53532c3969`). Because
  `VerificationSwarmDispatcher` defaults N to pool length, production
  review-eligible dispatches create N=2 staged sub-issues with distinct
  agent assignees.

  **Idempotency**: every dispatch first calls `GET /api/issues/{parent}/
  children` (what `multica issue children` uses) and skips creation
  entirely if any children already exist — checked live against the server
  every call, not an in-memory flag, so it survives a watcher restart
  re-observing an already-swarmed issue. An in-process per-issueId
  in-flight guard additionally serializes overlapping calls for the same
  parent within one instance.

  **Research finding — the "woken" mechanic is real**: `multica issue
  create --help` documents that completing every sub-issue in a stage
  "wakes" the parent's assignee, but this had never been exercised live
  before this story. Empirically confirmed (toy issues PAN-4428/4429/4430,
  since cleaned up): completing the LAST sub-issue in a stage causes
  Multica's server to post a system comment on the PARENT issue
  @-mentioning its assignee, which genuinely dispatches a fresh agent run
  against that assignee (`multica issue runs <parent>` shows a
  comment-triggered run within ~1s of the last sub-issue finishing). The
  parent's `status` was untouched throughout. See the full narrative in
  `auriga/watcher/verification-swarm.ts`'s class doc comment. **Correction**
  (found on review before verdict-synthesis-escalation was dispatched): that
  dispatch targets Multica's own agent runtime, not this Node process --
  `auriga/run.ts` has no way to receive it. verdict-synthesis-escalation
  still needs its own in-process `issue children` poll as its real trigger,
  consistent with the rest of this epic's architecture; the "woken"
  mechanism is a useful redundant notification for whoever Multica has
  assigned, not a trigger this codebase can consume directly.

  Also added on review: each sub-issue's description instructs its verifier
  to record their verdict by setting THAT SUB-ISSUE's own status --
  `done` = approve, `blocked` = reject. This is the exact, unambiguous
  convention verdict-synthesis-escalation reads back.

- `auriga/watcher/verdict-synthesis.ts` — `VerdictSynthesizer`, the
  dependent story that reads the verdicts `VerificationSwarmDispatcher`
  leaves behind. Nothing calls back into this codebase when a swarm
  finishes (Multica's own "parent assignee is woken" mechanism dispatches
  against Multica's own agent runtime, a separate system -- see the
  "woken" section above), so this is its own in-process poll loop, built
  the same way as `BoardStateWatcher`: self-scheduling `setTimeout`,
  constructor-required `projectId`, a `project_id` query param plus a
  client-side fail-closed filter.

  Each poll tick lists this project's `in_review`-status issues and, for
  any with existing stage-1 children where every child has reached a
  terminal status (`done`/`blocked` -- read directly off `issue children`,
  never inferred from a comment or label), resolves it:

  - **Unanimous approve** (every child `done`) -- marks the parent `done`
    via the existing `TrackerAdapter.updateStatus` (no new adapter method;
    the write path is reused, not reinvented).
  - **Any disagreement** (at least one child `blocked`) -- writes an
    `EscalationRecord` via the existing `DBAdapter`, and leaves the parent
    at `review`, completely unchanged (no `updateStatus` call exists on
    this path at all). This is the concrete satisfaction of
    `docs/initial-info/04-mvp-boundary.md`'s "never a reviewer /
    second-opinion model as a hard gate": disagreement never auto-approves
    and never blocks harder than "stays in review, pending human/
    Consus-level judgment" -- the same escalate-don't-auto-resolve
    posture P1's `SustainedDeclineDetector` (`auriga/escalation/index.ts`)
    established for sustained dispatch failure. Rather than inventing a
    second, parallel escalation record type, `EscalationRecord` there was
    widened into a discriminated union: the existing `reason:
    "sustained_decline"` variant is untouched, and a new
    `VerdictDisagreementEscalationRecord` (`reason: "verdict_disagreement"`,
    carrying the parent issue id and every child's id/status) was added as
    a second member of that same exported type, so both escalation sources
    read the same way for a human or Consus later.
  - **Not all children terminal yet** -- does nothing this tick; no
    premature read, no partial-verdict guess. An empty children array
    (swarm not dispatched, or not yet observed) is checked and rejected
    explicitly before any terminal/approve check, since `[].every(...)` is
    vacuously `true` in JS and would otherwise silently auto-approve a
    parent nothing has actually reviewed.

  **Idempotency**: mirrors `BoardStateWatcher`'s `#lastKnownStatus`
  pattern -- an in-memory `Set` of already-synthesized parent ids, checked
  before any children fetch or write is attempted again. This matters most
  for the disagreement branch: an escalated parent's status is
  deliberately left at `review`, so it keeps reappearing in every future
  poll's review-status list; without this tracking every later tick would
  write a duplicate `EscalationRecord` for the same already-escalated
  disagreement.

## `auriga/run.ts` — process composition

The real, deployable process entrypoint (`tsx auriga/run.ts`) — one
long-running process composing every real implementation this epic has
produced, kept alive by four independent interval-based loops (no
subprocess, no separate process per loop):

1. **Synthetic workload generator** (P1) — pre-creates a real Multica issue
   per tick and drives it through `AurigaConsumer.onEvent()`, since nothing
   else in P1 originates real claimable-work events.
2. **Sweep** — reclaims completed/stale leases via `InstrumentedLock.sweep()`.
3. **Counters/observability** — derives and persists dispatch counters
   (`deriveCounters()` + `ObservabilityCounterStore`) and prints a
   human-readable status line.
4. **Board-state watcher** (P2, `auriga/watcher/`) — polls live Multica for
   real board-state transitions and, via `auriga/watcher/dispatch-wiring.ts`,
   feeds its `"dispatch-eligible"` events into the SAME `onEvent()` path the
   synthetic generator uses — a second, real event source, additive to (not
   a replacement of) the synthetic one. `BoardStateWatcher` manages its own
   self-scheduling poll loop internally; `run.ts` does not wrap it in a
   second timer.
5. **Verdict synthesizer** (P2, `auriga/watcher/verdict-synthesis.ts`) —
   polls live Multica for review-status issues, reads back verification-swarm
   verdicts, and marks the parent `done` (unanimous approve) or writes an
   `EscalationRecord` (disagreement). Same self-scheduling poll-loop shape as
   the board-state watcher, running alongside it in this same process.

See `auriga/run.ts`'s own header doc comment for the full rationale behind
every default/env-override, and `.pHive/epics/board-state-machine/docs/
design-discussion.md` (§5a resolution 4) for why the watcher is a fourth
loop in this same process rather than a separate one.

### Observability counters

`auriga/observability/counters.ts` + `ObservabilityCounterStore` are the
single measurable-truth surface for this whole orchestrator — every counter
below is derived from a real, observed event stream via a pure derivation
function (`deriveCounters()` / `deriveTransitionVerdictCounts()`, no I/O)
and persisted to the SAME sqlite file (`auriga/observability/counters.db`),
never self-reported:

- **dropped / duplicated tasks** (P1) — derived by `deriveCounters()` from
  `InstrumentedLock`'s real `LockEvent` stream (`auriga/observability/
  instrumented-lock.ts`, wrapping the real `MulticaLock`), persisted in the
  `dropped_tasks`/`duplicated_tasks` tables.
- **death/restart counts** (P1) — `auriga/observability/death-detection.ts`'s
  `HeartbeatWriter`/`detectPreviousDeath()`/`DeathEventStore`, distinguishing
  a clean shutdown from a real process death across runs.
- **board-state transitions and verdict-synthesis outcomes** (P2, this
  story) — `InstrumentedWatcher`/`InstrumentedVerdictSynthesizer`
  (`auriga/observability/instrumented-watcher.ts` /
  `instrumented-verdict-synthesizer.ts`) mirror `InstrumentedLock`'s own
  "wrap + observe + re-emit" decorator shape around `BoardStateWatcher`'s
  real `"dispatch-eligible"`/`"review-eligible"` events and
  `VerdictSynthesizer`'s real `"verdict-approved"`/`"verdict-escalated"`
  events, persisted into the SAME `ObservabilityCounterStore` instance
  (extended with `transitions`/`verdicts` tables, not a second store).
  `deriveTransitionVerdictCounts()` computes four counts purely from that
  stream: transitions fired, swarms dispatched (approximated as the
  `review-eligible` count), unanimous-approve count, and escalation count —
  so "did auto-dispatch fire," "did the swarm run," and "what did it
  conclude" are as verifiable as P1's soak-test numbers, not narrated.
