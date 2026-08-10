import { randomUUID } from "node:crypto";
import type { LockContract, ClaimResult } from "../../contracts/lock.ts";

/**
 * Config needed to talk to a live Multica instance. Callers are expected to
 * read `~/.multica/config.json` themselves (per the friction-notes.md /
 * spike-doc precedent — this class never reads config files or env vars on
 * its own) and pass the fields in explicitly. `token` and `workspaceId`
 * are held only in memory for the lifetime of this instance; this class
 * never logs, persists, or otherwise writes them to disk.
 */
export interface MulticaLockConfig {
  serverUrl: string;
  workspaceId: string;
  token: string;
  /**
   * Staleness threshold (ms) used by sweep() to decide a tracked lease is
   * abandoned and should be reclaimed. Default: 5 minutes. This number is
   * arbitrary — Multica has no lease/TTL concept of its own (see the
   * findings doc), so "how long is too long to hold a lock" is entirely a
   * pantheon-orchestrator policy choice, not something derived from the
   * API. Exposed here as a constructor override so callers (and tests) can
   * tune it without subclassing.
   */
  staleMs?: number;
}

interface MulticaIssue {
  id: string;
  status: string;
  assignee_type: string | null;
  assignee_id: string | null;
  creator_id: string;
  [key: string]: unknown;
}

interface TrackedLease {
  taskId: string;
  issueId: string;
  claimedAt: number;
}

const DEFAULT_STALE_MS = 5 * 60 * 1000; // 5 minutes — see MulticaLockConfig.staleMs doc above.

/**
 * Decode a JWT's payload without verifying its signature. We only need the
 * `sub` claim (our own caller/member id) to populate `assignee_id` on
 * claim PUTs — Multica itself already validated and issued this token, so
 * re-verifying its signature here would be redundant. Never logged.
 */
function decodeJwtSubject(token: string): string {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("MulticaLock: token does not look like a JWT (expected header.payload.sig)");
  }
  const payloadPart = parts[1];
  if (!payloadPart) {
    throw new Error("MulticaLock: token missing payload segment");
  }
  const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as {
    sub?: string;
  };
  if (!payload.sub) {
    throw new Error("MulticaLock: JWT payload has no `sub` claim to use as caller id");
  }
  return payload.sub;
}

/**
 * MulticaLock — LockContract (contracts/lock.ts) implemented against the
 * LIVE Multica issue API, per the empirical findings in
 * .pHive/epics/contracts-and-spine/docs/multica-lock-api-findings.md.
 *
 * Multica has no dedicated claim/lease/sweeper API. There is no `/tasks`,
 * `/lock`, or `/sweep` route, no lease/TTL field on the issue shape, and
 * (empirically confirmed by the spike) the plain issue-PUT that stands in
 * for "claim" gives zero compare-and-swap: two concurrent PUTs on the same
 * unclaimed issue both return 200. Every guarantee this class provides
 * beyond that blind write is synthesized entirely client-side, per the
 * findings doc's AD-5 go/no-go call (GO, with an application-level
 * idempotency/CAS wrapper required by design, not optional).
 *
 * ## claim() atomicity — two different guarantees, honestly labeled
 *
 * 1. Same-instance race (e.g. `Promise.all([lock.claim(t), lock.claim(t)])`
 *    against the SAME MulticaLock object): fully deterministic, exactly one
 *    winner. This is enforced by an in-process per-taskId mutex
 *    (`#withTaskLock`) that serializes claim() calls before they ever touch
 *    the network — the second call simply doesn't start its GET until the
 *    first has finished its PUT, so they never interleave. This is within
 *    our control and does not depend on anything Multica does or doesn't
 *    provide.
 * 2. Cross-process race (two SEPARATE MulticaLock instances/processes
 *    sharing one Multica identity/token, racing the same underlying issue):
 *    NOT PROTECTED — confirmed empirically (20/20 double-claims in
 *    lock-concurrent-claim-tests, not occasional flakiness). Root cause is
 *    structural, not timing: claim()'s only conflict signal is comparing
 *    the post-PUT `assignee_id` against `#callerId`, and `#callerId` is
 *    derived from the auth token's JWT `sub` claim — every process sharing
 *    one token has the IDENTICAL `#callerId`, so the comparison can never
 *    distinguish winner from loser. This is not fixable by tightening the
 *    read-then-conditional-write timing; Multica gives no compare-and-swap,
 *    no conditional-write header, no version/etag, and (per the findings
 *    doc) no way to give two processes distinguishable identities in this
 *    workspace (`GET /api/agents` returns `[]` — no registered agent
 *    identities to assign per-process).
 *
 *    **Accepted scope decision (operator-confirmed, post-lock-concurrent-
 *    claim-tests):** P1's spine is a single thin consumer (see
 *    docs/north-star.md, README.md "Shape") — multi-worker coordination is
 *    explicitly P4 ("role-tree / squads / workflows"), not P1. This class
 *    therefore only guarantees claim-safety WITHIN one process (guarantee
 *    #1 above); running more than one MulticaLock-backed process against
 *    the same Multica workspace concurrently, before P4 lands its own
 *    coordination mechanism, WILL silently double-claim. Do not do that.
 *    Revisit this class (or replace it) when P4 actually introduces
 *    multiple workers.
 *
 * ## renew() — no server-side equivalent
 *
 * Confirmed by the findings doc (§2): no `/renew` or `/lease` route exists,
 * and no lease/TTL field exists on the issue shape to renew. renew() here
 * is a pure client-side no-op against our own tracking Map: it returns
 * `true` iff `leaseId` is a lease we currently have tracked as live, and
 * `false` otherwise. There is nothing on the Multica side to call.
 *
 * ## sweep() — client-side poll, scoped to OUR tracked leases only
 *
 * No sweep endpoint or lease-expiry concept exists on Multica (findings
 * doc §4). sweep() here polls `GET /api/issues?workspace_id=&status=
 * in_progress` (confirmed empirically to be a real server-side filter, not
 * a client-side no-op — see the probe run in this story's report) and
 * cross-references the result against leases THIS instance is tracking in
 * `#leases`, reclaiming (PUT back to unclaimed) any tracked lease whose
 * `claimedAt` age exceeds `staleMs` AND which the server still shows as
 * in_progress. Deliberately does NOT touch any in_progress issue this
 * instance didn't claim itself — reclaiming arbitrary workspace state would
 * be unsafe (some other process's live lease might be in_progress for
 * entirely legitimate reasons) and would violate the "sweep must not
 * reclaim a live lease" contract requirement the moment two independent
 * lock users share a workspace.
 *
 * ## taskId -> Multica issue mapping (test/adaptation note)
 *
 * `LockContract.claim(taskId)` is generic over "task id" as an application
 * concept; Multica has no separate "register a claimable unit" primitive
 * distinct from "an issue". This implementation therefore treats a
 * not-yet-seen `taskId` as something to auto-provision: the first claim()
 * call for an unrecognized taskId creates a new Multica issue (title
 * `"lock-impl-dev: " + taskId"`) and remembers the taskId -> issueId
 * mapping in `#taskIdToIssueId` for the lifetime of this instance. This is
 * a necessary adaptation for exercising this class against the contract
 * test harness (whose generated task ids are opaque strings, not
 * pre-existing Multica issue ids) and is a legitimate implementation
 * decision for any taskId->resource scheme, not a hack.
 *
 * ## No internal error boundary here (deliberate — see auriga/consumer/)
 *
 * `#getIssue`/`#putIssue`/`#createIssue`/`#listInProgressIssueIds` are this
 * class's in-process Multica HTTP calls (AD-4) and were explicitly
 * considered for their own error boundary/EventEmitter during the
 * consumer-adapter-error-boundary story. Decision: NOT added here.
 * `AurigaConsumer` (the only in-process caller of `claim()` today) already
 * wraps `await this.#lock.claim(taskId)` in a try/catch that classifies
 * and emits a `ClassifiedFailure` — see its class doc's "Error boundary"
 * and "Why the boundary lives HERE and not inside MulticaLock too"
 * sections for the full reasoning. Short version: any exception thrown by
 * these private HTTP methods propagates up through `claim()`'s (or
 * `renew()`/`release()`/`sweep()`'s) awaited promise chain to whatever
 * calls the public method — for `claim()`, that's already caught one level
 * up, so a second boundary here would be redundant for this call graph,
 * and `LockContract`'s typed returns (`ClaimResult` has no "adapter
 * failed" variant) mean this class couldn't swallow such an error
 * internally without either violating the contract or re-throwing anyway.
 * If a future caller invokes `renew()`/`release()`/`sweep()` directly
 * in-process (none does yet — see class doc, "Accepted scope decision"),
 * THAT caller needs its own boundary, following this same pattern —
 * not something to speculatively build here ahead of that caller existing.
 */
export class MulticaLock implements LockContract {
  readonly #serverUrl: string;
  readonly #workspaceId: string;
  readonly #token: string;
  readonly #callerId: string;
  readonly #staleMs: number;

  /** taskId -> Multica issue id. Populated lazily on first claim() of a taskId. */
  readonly #taskIdToIssueId = new Map<string, string>();
  /** leaseId -> tracking record, present only while the lease is live. */
  readonly #leases = new Map<string, TrackedLease>();
  /** Issue ids this instance created via auto-provisioning (for test cleanup). */
  readonly #createdIssueIds = new Set<string>();
  /** Per-taskId serialization chain — see class doc, "same-instance race". */
  readonly #taskLocks = new Map<string, Promise<unknown>>();

  constructor(config: MulticaLockConfig) {
    this.#serverUrl = config.serverUrl.replace(/\/$/, "");
    this.#workspaceId = config.workspaceId;
    this.#token = config.token;
    this.#callerId = decodeJwtSubject(config.token);
    this.#staleMs = config.staleMs ?? DEFAULT_STALE_MS;
  }

  /** Issue ids auto-created by this instance so far — for test cleanup only. */
  get createdIssueIds(): readonly string[] {
    return [...this.#createdIssueIds];
  }

  async claim(taskId: string): Promise<ClaimResult> {
    return this.#withTaskLock(taskId, async () => {
      const issueId = await this.#resolveIssueId(taskId);

      const issue = await this.#getIssue(issueId);
      if (this.#isClaimed(issue)) {
        return { ok: false, reason: "already_claimed" };
      }

      await this.#putIssue(issueId, {
        status: "in_progress",
        assignee_type: "member",
        assignee_id: this.#callerId,
      });

      // Re-fetch and confirm we actually won — best-effort race detection,
      // see class doc's "cross-process / cross-instance race" section.
      const confirmed = await this.#getIssue(issueId);
      if (confirmed.assignee_id !== this.#callerId) {
        return { ok: false, reason: "already_claimed" };
      }

      const leaseId = `${issueId}:${randomUUID()}`;
      this.#leases.set(leaseId, { taskId, issueId, claimedAt: Date.now() });
      return { ok: true, leaseId };
    });
  }

  async renew(leaseId: string): Promise<boolean> {
    return this.#leases.has(leaseId);
  }

  async release(leaseId: string): Promise<void> {
    const lease = this.#leases.get(leaseId);
    if (!lease) return; // unknown leaseId: no-op, per contract harness usage
    await this.#putIssue(lease.issueId, {
      status: "todo",
      assignee_type: null,
      assignee_id: null,
    });
    this.#leases.delete(leaseId);
  }

  async sweep(): Promise<string[]> {
    if (this.#leases.size === 0) return [];

    const inProgressIds = await this.#listInProgressIssueIds();
    const now = Date.now();
    const reclaimed: string[] = [];

    for (const [leaseId, lease] of this.#leases) {
      const stillInProgress = inProgressIds.has(lease.issueId);
      const isStale = now - lease.claimedAt >= this.#staleMs;
      if (stillInProgress && isStale) {
        // Remove from the tracking map SYNCHRONOUSLY, before the await
        // that performs the reclaim PUT -- not after. sweep() is not
        // guarded by #withTaskLock (that's claim()-only, see class doc),
        // so two sweep() calls on the same instance can genuinely
        // interleave: each runs its own `for...of` over this same #leases
        // Map, and the only thing preventing both from reclaiming the
        // same lease is that JS never switches tasks mid-synchronous-run.
        // By deleting here (still synchronous, no await has happened yet
        // for this entry), a second concurrent sweep() whose iterator
        // hasn't yet reached this leaseId will find it already gone and
        // skip it -- so the lease is claimed by at most one sweep() call's
        // reclaimed[] list, exactly like #withTaskLock does for claim(),
        // just via a plain Map delete instead of a promise-chain mutex.
        this.#leases.delete(leaseId);
        await this.#putIssue(lease.issueId, {
          status: "todo",
          assignee_type: null,
          assignee_id: null,
        });
        reclaimed.push(lease.taskId);
      }
    }
    return reclaimed;
  }

  /**
   * TEST-ONLY hook: forces the tracked claimedAt for `leaseId` into the
   * past, beyond `staleMs`, so sweep() has something real to reclaim
   * without waiting on wall-clock time. Not part of LockContract. Intended
   * to be wired up as the contract test harness's optional `expireLease`
   * hook (contracts/test-harness/lock.ts).
   */
  expireLeaseForTesting(leaseId: string): void {
    const lease = this.#leases.get(leaseId);
    if (!lease) return;
    lease.claimedAt = Date.now() - this.#staleMs - 1_000;
  }

  #isClaimed(issue: MulticaIssue): boolean {
    return issue.status === "in_progress" && issue.assignee_id != null;
  }

  async #resolveIssueId(taskId: string): Promise<string> {
    const existing = this.#taskIdToIssueId.get(taskId);
    if (existing) return existing;

    const issue = await this.#createIssue(`lock-impl-dev: ${taskId}`);
    this.#taskIdToIssueId.set(taskId, issue.id);
    this.#createdIssueIds.add(issue.id);
    return issue.id;
  }

  async #listInProgressIssueIds(): Promise<Set<string>> {
    const url = this.#url("/api/issues", { status: "in_progress" });
    const res = await fetch(url, { headers: this.#headers() });
    if (!res.ok) {
      throw new Error(`MulticaLock: GET ${url} -> ${res.status}`);
    }
    const body = (await res.json()) as { issues: MulticaIssue[] };
    return new Set(body.issues.map((i) => i.id));
  }

  async #getIssue(issueId: string): Promise<MulticaIssue> {
    const url = this.#url(`/api/issues/${issueId}`);
    const res = await fetch(url, { headers: this.#headers() });
    if (!res.ok) {
      throw new Error(`MulticaLock: GET ${url} -> ${res.status}`);
    }
    return (await res.json()) as MulticaIssue;
  }

  async #putIssue(issueId: string, body: Record<string, unknown>): Promise<MulticaIssue> {
    const url = this.#url(`/api/issues/${issueId}`);
    const res = await fetch(url, {
      method: "PUT",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`MulticaLock: PUT ${url} -> ${res.status}`);
    }
    return (await res.json()) as MulticaIssue;
  }

  async #createIssue(title: string): Promise<MulticaIssue> {
    const url = this.#url("/api/issues");
    const res = await fetch(url, {
      method: "POST",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ title }),
    });
    if (res.status === 409) {
      // Multica enforces server-side duplicate-title detection
      // (`{"code":"active_duplicate_issue", "issue": {...}}`) — confirmed
      // empirically while building the cross-instance concurrent-claim
      // test (see auriga/lock/concurrent-claim.test.ts). This is the ONE
      // piece of real server-side compare-and-swap Multica gives us
      // anywhere in this class: when two separate MulticaLock instances
      // race #resolveIssueId() for the same never-before-seen taskId
      // (auto-provisioning a same-titled issue each), exactly one POST
      // wins with 201 and the other gets this 409 carrying the winner's
      // issue back in the body. Treat that as success — converge on the
      // existing issue — rather than throwing, so both instances end up
      // pointed at the same underlying issue and the actual claim() race
      // (not an issue-creation crash) is what gets exercised next.
      const body = (await res.json()) as { code?: string; issue?: MulticaIssue };
      if (body.code === "active_duplicate_issue" && body.issue) {
        return body.issue;
      }
      throw new Error(`MulticaLock: POST ${url} -> 409 (unrecognized conflict body: ${JSON.stringify(body)})`);
    }
    if (!res.ok) {
      throw new Error(`MulticaLock: POST ${url} -> ${res.status}`);
    }
    return (await res.json()) as MulticaIssue;
  }

  #url(path: string, extraParams: Record<string, string> = {}): string {
    const params = new URLSearchParams({ workspace_id: this.#workspaceId, ...extraParams });
    return `${this.#serverUrl}${path}?${params.toString()}`;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.#token}`, ...extra };
  }

  /**
   * Serializes async work per taskId so two claim() calls issued
   * concurrently from THIS instance never interleave their GET/PUT against
   * Multica — see class doc's "same-instance race" section. Chains onto
   * whatever promise is currently running for this taskId (or a resolved
   * one if none), regardless of whether it succeeded or failed, so a
   * failure never wedges the lock for that taskId forever.
   */
  async #withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.#taskLocks.get(taskId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // Swallow rejection in the chain slot itself (not in what we return)
    // so a failed claim doesn't permanently poison the lock for this taskId.
    this.#taskLocks.set(
      taskId,
      run.catch(() => undefined),
    );
    return run;
  }
}
