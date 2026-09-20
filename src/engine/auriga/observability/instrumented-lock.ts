import { EventEmitter } from "node:events";
import type { LockContract, ClaimResult } from "../../contracts/lock.ts";
import type { LockEvent } from "./counters.ts";

/**
 * auriga/observability/instrumented-lock.ts — the missing piece
 * `counters.ts`'s own doc comment flags as "out of scope, not yet wired
 * anywhere in this epic": something that actually emits a `LockEvent`
 * stream from real `claim()`/`release()` calls, so `deriveCounters()` can
 * be run against something other than a hand-written synthetic array.
 *
 * ## Decorator pattern, not a MulticaLock subclass or a fork
 *
 * `InstrumentedLock` wraps any `LockContract` implementation (in practice,
 * a real `MulticaLock`, but it is written against the contract, not the
 * concrete class, so a fake would work identically in a test) and forwards
 * every call straight through unchanged, additionally recording a
 * `LockEvent` for each observable transition. This is the exact same
 * decorator shape as `SignalingLock` in
 * auriga/consumer/restart-safety-runner.ts (wrap a real `LockContract`,
 * delegate every method, layer in one extra side effect) — chosen
 * deliberately to follow that established precedent rather than invent a
 * new pattern. Unlike `SignalingLock` (single-purpose scaffolding private
 * to one runner script, printing a stdout marker for a child-process
 * test), this class is genuinely reusable: any test or future real
 * entrypoint that needs a real `LockEvent` stream out of a real lock can
 * wrap it in an `InstrumentedLock`, which is why it lives in
 * `auriga/observability/` (a real module other code can import) rather
 * than inside a single test file.
 *
 * ## Event derivation — what maps to what
 *
 *   - `claim()` resolving `{ok: true, leaseId}` -> records a `"claimed"`
 *     event (taskId, leaseId, timestamp = the instant the call resolved).
 *   - `claim()` resolving `{ok: false, reason: "already_claimed"}` ->
 *     records a `"claim_rejected"` event. `counters.ts` doesn't consume
 *     this kind yet (see its own doc comment) but the shape is captured
 *     now for the same reason `counters.ts` defines it: free today, useful
 *     for a future contention-rate counter.
 *   - `release()` -> records a `"released"` event, but ONLY if this same
 *     instance saw the matching `claimed` event first (tracked via an
 *     internal `leaseId -> taskId` map) — `LockContract.release()` takes
 *     only a `leaseId`, not a `taskId`, and `LockEvent`'s `released` variant
 *     requires a `taskId`, so that map is this class's only way to recover
 *     the taskId a bare `leaseId` belongs to. Releasing an unknown
 *     `leaseId` (never claimed through this instance) still delegates to
 *     the inner lock (matching `LockContract`'s no-op-on-unknown-leaseId
 *     behavior, see `MulticaLock.release`) but records no event, since
 *     there is no taskId to attribute it to.
 *   - `sweep()` -> for every taskId the inner lock reports reclaimed,
 *     records a `"released"` event for that taskId's currently-tracked open
 *     lease. This follows `counters.ts`'s own documented equivalence
 *     ("sweep() reclaiming a stale lease... also ends the lease's
 *     'held' interval, just via a different code path... either should be
 *     reported as `released` here").
 *   - `renew()` -> delegates only; `LockEvent` has no renew variant
 *     (`counters.ts` doesn't derive anything from renewals today), so
 *     nothing is recorded.
 *
 * ## Two ways to consume the stream
 *
 * `events` returns a defensive-copy snapshot array (safe to pass straight
 * into `deriveCounters()`). This instance is ALSO a Node `EventEmitter`
 * that emits `"event"` with each `LockEvent` the instant it's recorded, for
 * callers that want to observe the stream live rather than poll a
 * snapshot after the fact.
 */
export class InstrumentedLock extends EventEmitter implements LockContract {
  readonly #inner: LockContract;
  readonly #events: LockEvent[] = [];
  /** leaseId -> taskId, for leases claimed through THIS instance. */
  readonly #taskIdByLeaseId = new Map<string, string>();
  /** taskId -> its currently-open leaseId (through this instance), so
   * sweep()'s reclaimed-taskId list can be translated back to a leaseId. */
  readonly #openLeaseIdByTaskId = new Map<string, string>();

  constructor(inner: LockContract) {
    super();
    this.#inner = inner;
  }

  /** Snapshot of every `LockEvent` recorded so far, in the order observed. */
  get events(): readonly LockEvent[] {
    return [...this.#events];
  }

  async claim(taskId: string): Promise<ClaimResult> {
    const result = await this.#inner.claim(taskId);
    const timestamp = Date.now();
    if (result.ok) {
      this.#taskIdByLeaseId.set(result.leaseId, taskId);
      this.#openLeaseIdByTaskId.set(taskId, result.leaseId);
      this.#record({ type: "claimed", taskId, leaseId: result.leaseId, timestamp });
    } else {
      this.#record({ type: "claim_rejected", taskId, timestamp });
    }
    return result;
  }

  async renew(leaseId: string): Promise<boolean> {
    return this.#inner.renew(leaseId);
  }

  async release(leaseId: string): Promise<void> {
    await this.#inner.release(leaseId);
    const taskId = this.#taskIdByLeaseId.get(leaseId);
    if (taskId === undefined) return; // unknown leaseId -- see class doc.
    this.#record({ type: "released", taskId, leaseId, timestamp: Date.now() });
    this.#taskIdByLeaseId.delete(leaseId);
    if (this.#openLeaseIdByTaskId.get(taskId) === leaseId) {
      this.#openLeaseIdByTaskId.delete(taskId);
    }
  }

  async sweep(): Promise<string[]> {
    const reclaimedTaskIds = await this.#inner.sweep();
    const timestamp = Date.now();
    for (const taskId of reclaimedTaskIds) {
      const leaseId = this.#openLeaseIdByTaskId.get(taskId);
      if (leaseId === undefined) continue; // reclaimed a lease this instance never tracked as open
      this.#record({ type: "released", taskId, leaseId, timestamp });
      this.#taskIdByLeaseId.delete(leaseId);
      this.#openLeaseIdByTaskId.delete(taskId);
    }
    return reclaimedTaskIds;
  }

  #record(event: LockEvent): void {
    this.#events.push(event);
    this.emit("event", event);
  }
}
