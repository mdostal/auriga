import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  TrackerAdapter,
  TaskStatus,
  TaskRecord,
  LockResult,
} from "../../../contracts/tracker-adapter.ts";

/** Shape of `~/.multica/config.json`, as read at runtime by loadMulticaConfig(). */
export interface MulticaConfig {
  server_url: string;
  workspace_id: string;
  token: string;
}

/** The subset of a real Multica issue this adapter reads/writes. Multica's
 * full issue shape has more fields (priority, description, labels, etc.)
 * — see the findings doc — but TrackerAdapter only needs these three. */
interface MulticaIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assignee_type: string | null;
  assignee_id: string | null;
}

/**
 * Reads and validates `~/.multica/config.json` at call time (never at
 * module-load time, and never cached across calls) so the token/workspace
 * are always sourced fresh from disk, per this story's constraint that the
 * token must never be hardcoded in source. Does not log or otherwise
 * surface the token value.
 */
export function loadMulticaConfig(
  configPath: string = join(homedir(), ".multica", "config.json"),
): MulticaConfig {
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<MulticaConfig>;
  if (!parsed.server_url || !parsed.workspace_id || !parsed.token) {
    throw new Error(
      `${configPath} is missing one of server_url/workspace_id/token`,
    );
  }
  return {
    server_url: parsed.server_url,
    workspace_id: parsed.workspace_id,
    token: parsed.token,
  };
}

/**
 * Decodes (does NOT verify) the `sub` claim out of a JWT's payload segment.
 * Multica's `assignee_id` on a claim-style write must be a real
 * member/agent id in the workspace or the API 400s
 * (`assignee_id does not refer to an agent of this workspace`), and
 * `GET /api/agents?workspace_id=<ws>` returns `[]` in this workspace (no
 * registered agents), so the only usable assignee is the authenticated
 * user's own member id — the token's `sub` claim. Verified empirically:
 * decoding the configured token's `sub` here yields
 * `6506b1e5-08da-452c-81d9-d32e2ca31950`, which matches both the findings
 * doc's exercised `assignee_id`/`creator_id` and this story's own live
 * probe (`creator_id` on a freshly-created issue equals this `sub`).
 * Signature verification is intentionally skipped: this adapter trusts
 * whatever token Multica itself already accepted (the server re-validates
 * every request), and no local key material exists to verify against.
 */
function decodeJwtSubClaim(token: string): string {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("Multica token is not a well-formed JWT (expected 3 dot-separated segments)");
  }
  const payloadJson = Buffer.from(parts[1] as string, "base64url").toString("utf8");
  const payload = JSON.parse(payloadJson) as { sub?: string };
  if (!payload.sub) {
    throw new Error("Multica token payload has no `sub` claim");
  }
  return payload.sub;
}

/**
 * TaskStatus <-> Multica status mapping.
 *
 * Empirically determined (2026-07-24, live probe against
 * http://localhost:8090, workspace Pantheon/PAN) by creating a real issue
 * and PUTting every contract TaskStatus plus several likely Multica
 * values at it:
 *
 *   - A freshly POSTed issue defaults to `status: "todo"`.
 *   - `PUT {status:"pending"}`     -> 400 `invalid status "pending"; valid
 *     values: backlog, todo, in_progress, in_review, done, blocked, cancelled`
 *   - `PUT {status:"in_progress"}` -> 200, round-trips as "in_progress"
 *   - `PUT {status:"done"}`        -> 200, round-trips as "done"
 *   - `PUT {status:"blocked"}`     -> 200, round-trips as "blocked"
 *   - `PUT {status:"todo"}`        -> 200, round-trips as "todo"
 *   - `PUT {status:"backlog"}`     -> 200, round-trips as "backlog"
 *   - `PUT {status:"in_review"}`   -> 200, round-trips as "in_review"
 *   - `PUT {status:"cancelled"}`   -> 200, round-trips as "cancelled"
 *   - `PUT {status:"canceled"}` (US spelling) -> 400, same error list as above
 *
 * So Multica's real, complete status enum is exactly:
 * `backlog | todo | in_progress | in_review | done | blocked | cancelled`.
 * The contract's four-value TaskStatus (`pending|in_progress|done|blocked`)
 * is a strict subset in name for three of the four values, but "pending"
 * has no same-named Multica counterpart and must be translated.
 *
 * Forward mapping (contract -> Multica), used by updateStatus/claimTask:
 *   pending     -> todo         (Multica's own creation default; the
 *                                 natural "not started yet" state)
 *   in_progress -> in_progress  (identical string, verified round-trips)
 *   review      -> in_review    (faithful mapping, verified round-trips --
 *                                 see adapter-in-review-mapping, stage 2)
 *   done        -> done         (identical string, verified round-trips)
 *   blocked     -> blocked      (identical string, verified round-trips)
 *
 * Inverse mapping (Multica -> contract), used by getTask. Multica has two
 * states with no contract equivalent (backlog, cancelled) that can only be
 * reached by writing directly through the real Multica UI/API (this
 * adapter's own updateStatus/claimTask never produce them) but must still
 * be handled since getTask can observe any real issue:
 *   todo        -> pending      (inverse of the forward mapping above)
 *   in_progress -> in_progress
 *   in_review   -> review       (faithful mapping, inverse of review above)
 *   done        -> done
 *   blocked     -> blocked
 *   backlog     -> pending      (closest analogue: not started / queued,
 *                                 same bucket as "todo")
 *   cancelled   -> blocked      (closest analogue: not progressing toward
 *                                 done and not going to on its own; the
 *                                 only one of the four original contract
 *                                 states that signals "not moving forward
 *                                 normally")
 *
 * `review` <-> `in_review` (added by adapter-in-review-mapping, stage 2 of
 * board-state-machine, replacing contract-widen-taskstatus-review's
 * stage-1 type-satisfying placeholder that lossily collapsed both
 * directions into `in_progress`): getTask()/updateStatus() now round-trip
 * this pair faithfully, verified against a live Multica issue in
 * index.test.ts.
 */
const CONTRACT_TO_MULTICA_STATUS: Record<TaskStatus, string> = {
  pending: "todo",
  in_progress: "in_progress",
  review: "in_review",
  done: "done",
  blocked: "blocked",
};

const MULTICA_TO_CONTRACT_STATUS: Record<string, TaskStatus> = {
  todo: "pending",
  in_progress: "in_progress",
  in_review: "review",
  done: "done",
  blocked: "blocked",
  backlog: "pending",
  cancelled: "blocked",
};

interface MulticaResponse {
  status: number;
  json: unknown;
}

/**
 * MulticaTrackerAdapter — TrackerAdapter (contracts/tracker-adapter.ts)
 * implemented against the live Multica issue-tracker API.
 *
 * Design choices, all backed by empirical probes against a live instance
 * (see `.pHive/epics/contracts-and-spine/docs/multica-lock-api-findings.md`
 * for the sibling lock-contract spike this reuses the PUT-based write path
 * from, plus this story's own additional probe of the write-method and
 * status-enum questions the lock spike didn't need to answer):
 *
 * - **PUT, not PATCH.** `PATCH /api/issues/:id` returns `405 Method Not
 *   Allowed`. `PUT` is Multica's only per-issue write path — confirmed
 *   directly, not assumed, matching the findings doc's lock-specific PUT
 *   usage.
 * - **PUT is a partial merge, not a full-replace.** Empirically verified:
 *   `PUT {status:"in_progress"}` alone (omitting title/description/
 *   assignee/etc.) left every other field — including a previously-set
 *   `assignee_id` — unchanged in the response; only `status` and
 *   `updated_at` changed. This means `updateStatus()` below can safely
 *   send `{status: ...}` alone without first reading the issue to
 *   preserve other fields, and without clobbering a claim's assignee.
 *   (Had PUT been full-replace, omitted fields would have been nulled out
 *   — that is NOT what was observed.)
 * - **`getTask` uses Multica's `id` (UUID), not `identifier` (`PAN-N`).**
 *   `id` is the stable primary key Multica's own routes key off of
 *   (`GET/PUT/DELETE /api/issues/:id`), so using it as this adapter's
 *   `taskId` keeps every method's `taskId` parameter directly usable as
 *   the URL path segment with no secondary lookup. `identifier` is a
 *   human-facing display string tied to `number`, not guaranteed to be a
 *   universally-unique or even a routable value on its own.
 * - **`expiresAt` is always `null`.** Multica's issue shape has no lease/
 *   TTL/expiry field of any kind (confirmed by the lock-spike's key-scan
 *   and reconfirmed here) — there is nothing honest to synthesize a real
 *   expiry from. `LockResultSchema.expiresAt` is nullable regardless of
 *   `claimed`, so returning `null` on a successful claim is schema-valid
 *   and, unlike inventing an arbitrary TTL, does not imply a guarantee
 *   this adapter cannot back up (no renew/sweep path exists to honor it).
 * - **`lockId` is synthesized client-side**, since Multica returns no
 *   lock/lease token of its own (same finding as the lock spike). It is
 *   built as `multica:<issueId>:<randomUUID>` — enough to be unique per
 *   claim call and traceable back to the issue it claimed, while being
 *   explicit in its own name that it is this adapter's invention, not a
 *   Multica-issued value.
 * - **`claimTask` on an unknown id returns `{claimed:false,...}` rather
 *   than throwing.** A `GET` is issued first; Multica returns `404
 *   {"error":"issue not found"}` for both a well-formed-but-nonexistent
 *   UUID and a malformed (non-UUID) id string (both verified live), so a
 *   404 on the existence check is treated uniformly as "not claimable"
 *   without ever attempting the write.
 * - **`getTask` on an unknown id rejects.** `TaskRecord` has no
 *   not-found representation (contract's own doc comment on
 *   `TrackerAdapter` / the harness's own note), so a 404 GET throws
 *   rather than returning a sentinel value.
 */
export class MulticaTrackerAdapter implements TrackerAdapter {
  readonly #baseUrl: string;
  readonly #workspaceId: string;
  readonly #token: string;
  readonly #assigneeId: string;

  constructor(config: MulticaConfig) {
    this.#baseUrl = config.server_url.replace(/\/+$/, "");
    this.#workspaceId = config.workspace_id;
    this.#token = config.token;
    this.#assigneeId = decodeJwtSubClaim(config.token);
  }

  /** Convenience factory: builds an adapter from `~/.multica/config.json`, read fresh at call time. */
  static fromLocalConfig(configPath?: string): MulticaTrackerAdapter {
    return new MulticaTrackerAdapter(loadMulticaConfig(configPath));
  }

  async #request(
    method: "GET" | "PUT" | "DELETE",
    issuePath: string,
    body?: unknown,
  ): Promise<MulticaResponse> {
    const url = `${this.#baseUrl}${issuePath}?workspace_id=${this.#workspaceId}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // No body (e.g. 204 on DELETE) — leave json as null.
    }
    return { status: res.status, json };
  }

  async claimTask(taskId: string): Promise<LockResult> {
    const existing = await this.#request("GET", `/api/issues/${taskId}`);
    if (existing.status === 404) {
      return { claimed: false, lockId: null, expiresAt: null };
    }
    if (existing.status !== 200) {
      throw new Error(
        `MulticaTrackerAdapter.claimTask: GET /api/issues/${taskId} failed (${existing.status}): ${JSON.stringify(existing.json)}`,
      );
    }

    const claim = await this.#request("PUT", `/api/issues/${taskId}`, {
      status: CONTRACT_TO_MULTICA_STATUS.in_progress,
      assignee_type: "member",
      assignee_id: this.#assigneeId,
    });
    if (claim.status !== 200) {
      throw new Error(
        `MulticaTrackerAdapter.claimTask: PUT /api/issues/${taskId} failed (${claim.status}): ${JSON.stringify(claim.json)}`,
      );
    }

    return {
      claimed: true,
      lockId: `multica:${taskId}:${randomUUID()}`,
      expiresAt: null,
    };
  }

  async updateStatus(taskId: string, status: TaskStatus): Promise<void> {
    const multicaStatus = CONTRACT_TO_MULTICA_STATUS[status];
    const res = await this.#request("PUT", `/api/issues/${taskId}`, {
      status: multicaStatus,
    });
    if (res.status === 404) {
      throw new Error(`MulticaTrackerAdapter.updateStatus: unknown task id "${taskId}"`);
    }
    if (res.status !== 200) {
      throw new Error(
        `MulticaTrackerAdapter.updateStatus: PUT /api/issues/${taskId} failed (${res.status}): ${JSON.stringify(res.json)}`,
      );
    }
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    const res = await this.#request("GET", `/api/issues/${taskId}`);
    if (res.status === 404) {
      throw new Error(`MulticaTrackerAdapter.getTask: unknown task id "${taskId}"`);
    }
    if (res.status !== 200) {
      throw new Error(
        `MulticaTrackerAdapter.getTask: GET /api/issues/${taskId} failed (${res.status}): ${JSON.stringify(res.json)}`,
      );
    }

    const issue = res.json as MulticaIssue;
    const status = MULTICA_TO_CONTRACT_STATUS[issue.status];
    if (!status) {
      throw new Error(
        `MulticaTrackerAdapter.getTask: unrecognized Multica status "${issue.status}" on issue ${taskId}`,
      );
    }

    return { id: issue.id, status, title: issue.title };
  }
}
