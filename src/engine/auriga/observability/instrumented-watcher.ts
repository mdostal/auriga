import { EventEmitter } from "node:events";
import type { BoardStateTransitionEvent } from "../watcher/index.ts";
import type { TransitionEvent } from "./counters.ts";

/**
 * auriga/observability/instrumented-watcher.ts — InstrumentedWatcher: mirrors
 * `InstrumentedLock`'s own "wrap + observe + re-emit" decorator shape
 * (`auriga/observability/instrumented-lock.ts`'s class doc), applied to
 * `BoardStateWatcher`'s real `"dispatch-eligible"`/`"review-eligible"`
 * events (`auriga/watcher/index.ts`) instead of `LockContract`'s
 * claim/release calls.
 *
 * ## Why this doesn't delegate method calls the way InstrumentedLock does
 *
 * `InstrumentedLock` wraps a `LockContract` because `LockContract` itself
 * emits no events at all -- `InstrumentedLock` is what MAKES a `LockEvent`
 * stream exist, by intercepting every method call and deriving an event
 * from each result. `BoardStateWatcher` is different: it is ALREADY a Node
 * `EventEmitter` that emits exactly the two transition events this story
 * needs, unmodified (see observability-transition-verdict-counters.yaml's
 * own NOTE -- "no new event names need inventing"). So `InstrumentedWatcher`
 * does not re-implement or proxy `start()`/`stop()`/etc -- the composition
 * root (`auriga/run.ts`) keeps calling those directly on the real
 * `BoardStateWatcher` instance; `InstrumentedWatcher` only SUBSCRIBES to the
 * two events an already-constructed watcher emits (whether or not it has
 * been `start()`-ed yet -- subscribing is safe either way, since
 * `EventEmitter.on()` just registers a listener), translates each into a
 * `TransitionEvent`, records it, and re-emits it. Observe and record only,
 * per this story's own risk mitigation ("no behavioral coupling to the
 * watcher/synthesis logic it's observing").
 *
 * ## Two ways to consume the stream (same as InstrumentedLock)
 *
 * `events` returns a defensive-copy snapshot array (safe to pass straight
 * into `deriveTransitionVerdictCounts()`). This instance is ALSO a Node
 * `EventEmitter` that emits `"event"` with each `TransitionEvent` the
 * instant it's recorded, for callers that want to observe the stream live
 * rather than poll a snapshot after the fact.
 */

/** The narrow slice of `BoardStateWatcher` this class depends on -- an
 * EventEmitter emitting `"dispatch-eligible"`/`"review-eligible"` with
 * `BoardStateTransitionEvent`. Written against this shape, not the concrete
 * class (same reason `InstrumentedLock` is written against `LockContract`,
 * not `MulticaLock`), so a fake watcher works identically in tests. */
export interface TransitionEventSource {
  on(
    event: "dispatch-eligible" | "review-eligible",
    listener: (transition: BoardStateTransitionEvent) => void,
  ): unknown;
}

export class InstrumentedWatcher extends EventEmitter {
  readonly #events: TransitionEvent[] = [];

  constructor(inner: TransitionEventSource) {
    super();
    inner.on("dispatch-eligible", (transition) => {
      this.#record({
        type: "dispatch-eligible",
        issueId: transition.issueId,
        previousStatus: transition.previousStatus,
        timestamp: Date.now(),
      });
    });
    inner.on("review-eligible", (transition) => {
      this.#record({
        type: "review-eligible",
        issueId: transition.issueId,
        previousStatus: transition.previousStatus,
        timestamp: Date.now(),
      });
    });
  }

  /** Snapshot of every `TransitionEvent` recorded so far, in the order observed. */
  get events(): readonly TransitionEvent[] {
    return [...this.#events];
  }

  #record(event: TransitionEvent): void {
    this.#events.push(event);
    this.emit("event", event);
  }
}
