import { EventEmitter } from "node:events";
import type { VerdictApprovedEvent, VerdictEscalatedEvent } from "../watcher/verdict-synthesis.ts";
import type { VerdictEvent } from "./counters.ts";

/**
 * auriga/observability/instrumented-verdict-synthesizer.ts —
 * InstrumentedVerdictSynthesizer: the verdict-stream counterpart to
 * `InstrumentedWatcher` (`instrumented-watcher.ts`, same file this class
 * mirrors down to its doc-comment structure), itself mirroring
 * `InstrumentedLock`'s "wrap + observe + re-emit" decorator shape
 * (`auriga/observability/instrumented-lock.ts`'s class doc). Applied to
 * `VerdictSynthesizer`'s real `"verdict-approved"`/`"verdict-escalated"`
 * events (`auriga/watcher/verdict-synthesis.ts`) instead of `LockContract`'s
 * claim/release calls.
 *
 * Same rationale as `InstrumentedWatcher` for why this doesn't proxy
 * `start()`/`stop()`: `VerdictSynthesizer` is already an `EventEmitter`
 * emitting exactly the two verdict events this story needs, unmodified
 * (per observability-transition-verdict-counters.yaml's own NOTE -- "no new
 * event names need inventing"). This class only subscribes, translates each
 * event into a `VerdictEvent`, records it, and re-emits it -- observe and
 * record only, no behavioral coupling to the synthesis logic it observes.
 *
 * `events` returns a defensive-copy snapshot array (safe to pass straight
 * into `deriveTransitionVerdictCounts()`). This instance is ALSO a Node
 * `EventEmitter` that emits `"event"` with each `VerdictEvent` the instant
 * it's recorded, for live consumption.
 */

/** The narrow slice of `VerdictSynthesizer` this class depends on -- an
 * EventEmitter emitting `"verdict-approved"`/`"verdict-escalated"` with
 * `VerdictApprovedEvent`/`VerdictEscalatedEvent`. Written against this
 * shape, not the concrete class, so a fake synthesizer works identically in
 * tests. */
export interface VerdictEventSource {
  on(event: "verdict-approved", listener: (verdict: VerdictApprovedEvent) => void): unknown;
  on(event: "verdict-escalated", listener: (verdict: VerdictEscalatedEvent) => void): unknown;
}

export class InstrumentedVerdictSynthesizer extends EventEmitter {
  readonly #events: VerdictEvent[] = [];

  constructor(inner: VerdictEventSource) {
    super();
    inner.on("verdict-approved", (verdict) => {
      this.#record({
        type: "verdict-approved",
        issueId: verdict.issueId,
        subIssueIds: verdict.subIssueIds,
        timestamp: Date.now(),
      });
    });
    inner.on("verdict-escalated", (verdict) => {
      this.#record({
        type: "verdict-escalated",
        issueId: verdict.issueId,
        subIssueIds: verdict.subIssueIds,
        escalationKey: verdict.escalationKey,
        timestamp: Date.now(),
      });
    });
  }

  /** Snapshot of every `VerdictEvent` recorded so far, in the order observed. */
  get events(): readonly VerdictEvent[] {
    return [...this.#events];
  }

  #record(event: VerdictEvent): void {
    this.#events.push(event);
    this.emit("event", event);
  }
}
