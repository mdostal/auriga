import { EventEmitter } from "node:events";
import type { ConsumerContract } from "../../contracts/consumer.ts";
import type { EventContract } from "../../contracts/event.ts";
import type { ClaimResult, LockContract } from "../../contracts/lock.ts";
import type { TrackerAdapter } from "../../contracts/tracker-adapter.ts";

/**
 * ClassifiedFailure — the structured shape emitted on the consumer's
 * `"failure"` event whenever a wrapped in-process adapter call throws (see
 * AurigaConsumer's class doc, "Error boundary" section). This is the exact
 * signal format `escalation/`'s sustained-decline detector (built in the
 * next slice, not yet written) will subscribe to via
 * `consumer.on("failure", handler)` — treat this shape as a stable
 * contract, not an implementation detail.
 *
 * - `errorType` — a short classification string, not a full stack trace:
 *   the thrown value's `constructor.name` when it's an `Error` instance
 *   (e.g. `"TypeError"`, `"Error"`, or a custom Error subclass's name),
 *   falling back to `typeof error` (e.g. `"string"`, `"object"`) for the
 *   rare case of a non-Error throw. This keeps classification total (it
 *   never itself throws trying to classify) while staying human-scannable
 *   for grouping/counting in escalation/'s sustained-decline logic.
 * - `sourceAdapter` — which adapter call failed, at the granularity of
 *   "which dependency this class calls," not "which HTTP verb inside that
 *   dependency." Current values: `"lock"` (a `lock.claim()` failure) and
 *   `"trackerAdapter"` (a `trackerAdapter.updateStatus()` failure). See
 *   the class doc's "Error boundary" section for why this is the chosen
 *   granularity.
 * - `taskId` — optional because a future call site might fail before a
 *   task id can be derived; in the current `onEvent()` flow it is always
 *   populated (`#extractTaskId` is total and runs before either wrapped
 *   call), but the type stays honest about the general case.
 * - `timestamp` — ISO 8601, captured at catch time (not at the original
 *   call's start time).
 * - `error` — the original thrown value, unmodified, for anything that
 *   wants the full detail (e.g. logging) beyond the classification.
 */
export interface ClassifiedFailure {
  errorType: string;
  sourceAdapter: string;
  taskId?: string;
  timestamp: string;
  error: unknown;
}

/**
 * Classifies a thrown value into a short, stable string. See
 * ClassifiedFailure's `errorType` doc for the exact rule. Deliberately
 * total (never throws) — classification must not itself become a new
 * source of an uncaught exception inside the error boundary it serves.
 */
function classifyErrorType(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor.name || "Error";
  }
  return typeof error;
}

/**
 * AurigaConsumer — ConsumerContract (contracts/consumer.ts) implemented as
 * the thin, event-driven "spine" consumer lifted from plugin-hive's pattern
 * (README's "Shape": get from producer -> dispatch to the right service ->
 * close/error/retry; never does the work itself).
 *
 * ## Push-based, not polling
 *
 * ConsumerContract has no "listen for events" method by design (see its own
 * class doc) — `onEvent()` is called BY SOMETHING EXTERNAL (a Multica event
 * source, out of scope for this epic) to hand this consumer a
 * claimable-work event. This class never polls, subscribes, or otherwise
 * originates its own event loop; "get from producer" is satisfied entirely
 * by `onEvent()` being invoked externally.
 *
 * ## Dependency injection
 *
 * The lock and tracker adapter are constructor-injected, not internally
 * constructed (e.g. this class never calls `MulticaLock`/
 * `MulticaTrackerAdapter`/`loadMulticaConfig` itself). This keeps the class
 * substrate-agnostic (any `LockContract`/`TrackerAdapter` implementation
 * works, not just the Multica-backed ones) and lets tests pass in fakes/
 * spies instead of hitting a live service.
 *
 * ## onEvent() flow: claim -> dispatch, nothing else
 *
 * 1. Derive a `taskId` from the incoming event (see `#extractTaskId` doc
 *    below for the exact, documented mapping — EventContract itself does
 *    not define one).
 * 2. Call `lock.claim(taskId)`.
 * 3. If the claim is rejected (`{ok: false, reason: "already_claimed"}`),
 *    this is a normal, expected outcome per REQ-09/REQ-03 — another
 *    consumer (or another invocation of this one) already owns the task.
 *    `onEvent()` simply returns: no throw, no error-level log, no retry
 *    loop. It is not this consumer's job to decide what happens to a task
 *    it doesn't own.
 * 4. If the claim succeeds, dispatch by calling
 *    `trackerAdapter.updateStatus(taskId, "in_progress")` — marking the
 *    task as being worked in the tracker. That call is the entire
 *    dispatch: this class never executes the underlying task's actual work
 *    itself, and never does anything beyond claim + one tracker-adapter
 *    call. There is deliberately no code path here for running, awaiting,
 *    or otherwise performing the task.
 *
 * ## What this class does NOT do (by design, not omission)
 *
 * - It does not release the lock after dispatch. Releasing implies the
 *   work is done (or abandoned); this consumer only just handed the task
 *   off, it has no idea when — or whether — the work finishes. Release is
 *   the responsibility of whatever actually performs the work (out of
 *   scope for this epic's P1 spine), or of `lock.sweep()` if that work
 *   never reports back.
 * - It does not run its own retry loop or backoff policy. The "close/
 *   error/retry" half of the Kafka-consumer shape is still the external
 *   caller's responsibility to decide on — this class's job (per the error
 *   boundary below) is only to make sure a failure is caught, classified,
 *   and observable, not to decide what happens next.
 *
 * ## Error boundary (AD-4/REQ-12)
 *
 * Adapters run in-process (AD-4, a deliberate divergence from plugin-hive's
 * subprocess-ABI convention, for latency/simplicity — see
 * docs/design-discussion.md). That means an unhandled exception from
 * `lock.claim()` or `trackerAdapter.updateStatus()` shares this process's
 * event loop and, left uncaught, can crash the whole orchestrator —
 * directly undermining REQ-12's "never die silently, always
 * escalate-and-stop" invariant. So both in-process adapter call sites in
 * `onEvent()` are individually wrapped in try/catch:
 *
 * 1. `await this.#lock.claim(taskId)`
 * 2. `await this.#trackerAdapter.updateStatus(taskId, "in_progress")`
 *
 * When either throws, the exception is caught, classified into a
 * `ClassifiedFailure` (see its own doc above), and emitted on this
 * instance's `"failure"` event (this class extends `node:events`'
 * `EventEmitter` for exactly this purpose) — `onEvent()` then returns
 * normally. It deliberately does NOT re-throw (the process must survive)
 * and does NOT silently swallow (the emitted event IS the record; nothing
 * subscribes yet since `escalation/` — this signal's actual consumer — is
 * built in the next slice, but `EventEmitter` never throws on an
 * unhandled *custom* event the way it does for the special `"error"`
 * event, which is exactly why this event is named `"failure"` and not
 * `"error"`).
 *
 * ## Why the boundary lives HERE and not inside MulticaLock too
 *
 * `auriga/lock/index.ts`'s `MulticaLock` makes its own in-process Multica
 * HTTP calls (`#getIssue`/`#putIssue`/`#createIssue`/
 * `#listInProgressIssueIds`), which could in principle get their own,
 * separate error boundary. This class deliberately does NOT add one there
 * (no internal EventEmitter on MulticaLock, no wrapping of those private
 * methods) — see MulticaLock's class doc for the full reasoning. Short
 * version: this consumer is the only in-process caller of
 * `lock.claim()` today, and a thrown exception from anywhere inside
 * `claim()`'s call stack (including those private HTTP methods) already
 * propagates, via the awaited promise chain, straight up to this class's
 * `await this.#lock.claim(taskId)` — which this boundary already catches.
 * A second boundary inside MulticaLock would be redundant for the actual
 * call graph this epic ships, and LockContract's typed return values
 * (`ClaimResult` has no "adapter failed" variant) mean MulticaLock
 * couldn't swallow such an error internally without either fabricating a
 * non-conforming return value or re-throwing anyway — so there's nothing
 * for an internal boundary there to usefully do yet.
 */
export class AurigaConsumer extends EventEmitter implements ConsumerContract {
  readonly #lock: LockContract;
  readonly #trackerAdapter: TrackerAdapter;

  constructor(lock: LockContract, trackerAdapter: TrackerAdapter) {
    super();
    this.#lock = lock;
    this.#trackerAdapter = trackerAdapter;
  }

  /**
   * No lifecycle state to set up yet: this consumer holds no connection,
   * subscription, or buffer of its own (see class doc — it is purely
   * reactive to externally-invoked `onEvent()` calls). Kept as an explicit
   * async no-op, rather than omitted, so `start()` remains a real place to
   * add lifecycle setup later (e.g. warming a cache) without changing the
   * public surface.
   */
  async start(): Promise<void> {
    // Intentionally empty — see doc comment above.
  }

  async onEvent(event: EventContract): Promise<void> {
    const taskId = this.#extractTaskId(event);

    let claimResult: ClaimResult;
    try {
      claimResult = await this.#lock.claim(taskId);
    } catch (error) {
      // Error boundary #1 — see class doc's "Error boundary" section.
      // Catches anything thrown by lock.claim() itself, including an
      // exception originating deep inside MulticaLock's Multica HTTP
      // calls. Classified, emitted, NOT re-thrown: onEvent() must survive.
      this.#emitFailure(error, "lock", taskId);
      return;
    }

    if (!claimResult.ok) {
      // {ok: false, reason: "already_claimed"} is a normal, expected
      // outcome (REQ-03/REQ-09) — not an error. No dispatch, no throw.
      return;
    }

    try {
      await this.#trackerAdapter.updateStatus(taskId, "in_progress");
    } catch (error) {
      // Error boundary #2 — the tracker-adapter dispatch call.
      this.#emitFailure(error, "trackerAdapter", taskId);
      return;
    }
  }

  /**
   * Classifies a caught adapter exception and emits it on `"failure"`.
   * Never throws itself (see `classifyErrorType`'s doc) and never
   * re-throws the original error — this is the boundary that keeps the
   * process alive. `"failure"`, not `"error"`: Node's EventEmitter throws
   * synchronously if an `"error"` event has no listener, which would
   * defeat the entire point of this boundary the moment no one (e.g.
   * escalation/, not yet built) is subscribed.
   */
  #emitFailure(error: unknown, sourceAdapter: string, taskId: string | undefined): void {
    const failure: ClassifiedFailure = {
      errorType: classifyErrorType(error),
      sourceAdapter,
      taskId,
      timestamp: new Date().toISOString(),
      error,
    };
    this.emit("failure", failure);
  }

  /**
   * No lifecycle state to tear down yet — mirrors start(). Kept as an
   * explicit async no-op for the same reason: a real place to add cleanup
   * later without changing the public surface.
   */
  async stop(): Promise<void> {
    // Intentionally empty — see doc comment above.
  }

  /**
   * Derives a claimable task id from an incoming event.
   *
   * EventContract (contracts/event.ts) deliberately leaves `payload:
   * unknown` — it does not define an event -> task-id mapping, so this is
   * a documented, application-level choice specific to this
   * implementation, not something the contract mandates:
   *
   *   1. If `payload` is an object with a string `taskId` field, use that
   *      — the explicit, preferred signal a producer can set.
   *   2. Else if `payload` is an object with a string `id` field, use that
   *      as a reasonable fallback (many event producers reuse `id` for the
   *      thing the event is about).
   *   3. Otherwise, fall back to the event's own `id` (guaranteed present
   *      by EventContractSchema) — every conforming event has *an* id,
   *      even if it doesn't carry a separate task id in its payload. This
   *      also keeps `onEvent()` total over every conforming EventContract,
   *      which the generic contract-test harness (runConsumerContractTests)
   *      requires: it calls `onEvent()` with a payload
   *      (`{harness: true}`) that has neither field.
   */
  #extractTaskId(event: EventContract): string {
    const payload = event.payload;
    if (payload && typeof payload === "object") {
      const candidate = payload as Record<string, unknown>;
      if (typeof candidate.taskId === "string") {
        return candidate.taskId;
      }
      if (typeof candidate.id === "string") {
        return candidate.id;
      }
    }
    return event.id;
  }
}
