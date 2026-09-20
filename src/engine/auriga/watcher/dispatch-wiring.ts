// auriga/watcher/dispatch-wiring.ts — translates BoardStateWatcher's
// "dispatch-eligible" events into AurigaConsumer.onEvent() calls: the
// auto-dispatch-wiring story's own event-shape translation function,
// factored out of auriga/run.ts's composition root so it's unit-testable
// against a mocked-fetch watcher + a test-double consumer, independent of
// run.ts's own side-effecting main() (which reads ~/.multica/config.json
// and starts real timers as soon as it's invoked — see run.ts's own header
// doc). run.ts imports and calls wireDispatchEligible() as part of
// composing its fourth interval-based loop; this module owns no lifecycle
// of its own (no start()/stop(), no timers) — it only wires an already-
// running watcher's events to an already-constructed consumer.
//
// ## Why payload.taskId = issueId, not a synthetic wrapper
//
// AurigaConsumer.#extractTaskId() (auriga/consumer/index.ts) tries
// `payload.taskId` first, `payload.id` second, `event.id` last (see its own
// doc comment). Setting `payload.taskId` directly to the watcher's real
// Multica issue id makes the FIRST, most-preferred branch fire
// deterministically — this is a real board transition's issue id, not a
// synthetic payload standing in for one (contrast with run.ts's own
// synthetic workload generator, which pre-creates its OWN throwaway issue
// and uses ITS id the same way — see run.ts's header doc, "Synthetic
// workload"). #extractTaskId's own logic is untouched by this file; this
// module just feeds it the shape it already knows how to read.
//
// ## Claim rejection: no new handling here
//
// consumer.onEvent() already returns silently, without throwing, when
// lock.claim() reports {ok:false, reason:"already_claimed"} (see its own
// class doc, "onEvent() flow" step 3, and the "Error boundary" section).
// wireDispatchEligible() below simply calls onEvent() and does nothing else
// with its result — that existing silent behavior is exactly what a
// claim-already-taken dispatch-eligible event gets, with zero new branching
// introduced for it (this story's third acceptance criterion).
import { randomUUID } from "node:crypto";
import type { BoardStateWatcher, BoardStateTransitionEvent } from "./index.ts";
import type { EventContract } from "../../contracts/event.ts";

/** The narrow slice of AurigaConsumer this module depends on — lets tests
 * wire a lightweight test-double consumer instead of a real AurigaConsumer,
 * and keeps this module from needing to import AurigaConsumer itself. */
export interface OnEventConsumer {
  onEvent(event: EventContract): Promise<void>;
}

/**
 * Builds an EventContract from a real board-state transition. See this
 * file's header doc, "Why payload.taskId = issueId". A fresh, unique event
 * `id` is minted per call (not derived solely from `issueId`) since a
 * single issue can legitimately produce more than one dispatch-eligible
 * transition over its lifetime (see BoardStateWatcher's class doc,
 * "Exactly-once per transition" — leaving a status and coming back to
 * "todo" fires again, a fresh transition, not a repeat).
 */
export function toDispatchEvent(transition: BoardStateTransitionEvent): EventContract {
  return {
    id: `auriga-run:board-state-watcher:${transition.issueId}:${randomUUID()}`,
    type: "task.claimable",
    payload: { taskId: transition.issueId },
    timestamp: new Date().toISOString(),
    source: "auriga-run-board-state-watcher",
  };
}

/**
 * Subscribes to `watcher`'s "dispatch-eligible" event and, for each one,
 * translates it (toDispatchEvent) and calls `consumer.onEvent()` — the
 * exact P1 claim → lock → mark in_progress → hand-off path, invoked with a
 * real-transition-derived event instead of run.ts's synthetic workload
 * payload. Deliberately does NOT wire "review-eligible" — that transition
 * feeds a different, not-yet-built dispatch path (verification-swarm-
 * dispatch, out of this story's scope — see this story's own yaml,
 * "Do not touch verification-swarm.ts").
 *
 * Does not call `watcher.start()`/`stop()` — lifecycle stays the
 * composition root's (run.ts's) responsibility; this function only wires
 * the event once both objects already exist.
 *
 * `onEvent()` is documented to never throw (AurigaConsumer's own "Error
 * boundary" section — both its in-process adapter calls are already
 * individually try/caught and emitted as `"failure"`, not re-thrown). The
 * defensive `.catch()` below is a backstop matching run.ts's other three
 * interval loops' own try/catch-and-log convention (see run.ts's workload/
 * sweep/counters timers) — not a new handling path for the already-claimed
 * case (that's still onEvent()'s own existing silent return), only a safety
 * net against a genuinely unexpected throw so it can't become an unhandled
 * promise rejection off this synchronous event-listener callback.
 */
export function wireDispatchEligible(watcher: BoardStateWatcher, consumer: OnEventConsumer): void {
  watcher.on("dispatch-eligible", (transition: BoardStateTransitionEvent) => {
    const event = toDispatchEvent(transition);
    console.log(
      `[watcher-dispatch] issueId=${transition.issueId} previousStatus=${transition.previousStatus ?? "(none)"} -> onEvent(taskId=${transition.issueId})`,
    );
    void consumer.onEvent(event).catch((error: unknown) => {
      console.error(`[watcher-dispatch] onEvent() failed for issueId=${transition.issueId}:`, error);
    });
  });
}
