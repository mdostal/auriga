import { EventEmitter } from "node:events";

/**
 * auriga/watcher/verification-swarm.ts — VerificationSwarmDispatcher: reacts
 * to `BoardStateWatcher`'s `"review-eligible"` event (auriga/watcher/index.ts)
 * by dispatching a verification swarm -- N staged sub-issues created under
 * the review-eligible issue as parent, each `stage: 1`, each assigned to a
 * distinct verifier -- using Multica's native staged sub-issue barrier
 * primitive (`--parent <id> --stage <n>` on `multica issue create`, or the
 * equivalent raw `POST /api/issues` fields `parent_issue_id`/`stage` this
 * class uses directly, confirmed via direct API probing during this story's
 * research step).
 *
 * This story's scope is creation-only: it does NOT read verdicts back or
 * decide anything about the parent once the swarm is dispatched. That's
 * verdict-synthesis-escalation's job (a separate, dependent story).
 *
 * ## Research finding: what "the parent assignee is woken" actually does
 * (empirical, live Multica, captured during this story's research step --
 * see this repo's story YAML `.pHive/epics/board-state-machine/stories/
 * verification-swarm-dispatch.yaml` for the full toy-issue experiment)
 *
 * `multica issue create --help` documents `--stage`: "an ordered barrier
 * group under its parent... The parent assignee is woken only when every
 * sub-issue in a stage finishes." This was NOT previously exercised live.
 * Live-exercised now: a toy parent issue (PAN-4428) was assigned to agent
 * `auriga-dev` and given two `--stage 1` sub-issues (PAN-4429, PAN-4430),
 * each marked `done` in turn. Observed:
 *
 *   - Marking the FIRST sub-issue done changed nothing observable on the
 *     parent (no comment, no run, `issue children` correctly showed 1/2
 *     done for the stage).
 *   - Marking the SECOND (last) sub-issue in the stage done triggered a
 *     REAL, automatic effect on the parent: Multica's server posted a
 *     system comment on the PARENT issue itself (`author_type: "system"`),
 *     @-mentioning the parent's assignee, reading (verbatim): "Stage 1 of
 *     this issue is complete... Stage progress — Stage 1: 2/2 done...
 *     Decide whether the issue is actually complete... or whether the next
 *     stage still needs to be created". That comment then genuinely
 *     DISPATCHED a fresh agent run against the parent's assignee
 *     (`multica issue runs <parent>` showed a new run, `kind: "comment"`,
 *     `trigger_comment_id` set to that system comment's id, dispatched
 *     within ~1s of the last sub-issue completing). The run itself failed
 *     in this environment only because the test agent had hit an unrelated
 *     weekly rate limit -- the DISPATCH attempt, which is the mechanic this
 *     story cares about, unambiguously fired.
 *   - The parent issue's own `status` field was untouched by any of this
 *     (`in_review` before and after) -- Multica's own stage-completion
 *     mechanism does not touch the parent's status either, consistent with
 *     this story's own "don't modify the parent" requirement below.
 *
 * Conclusion: "woken" is real, not just help-text aspiration -- completing
 * the last sub-issue in a stage causes Multica itself to post a system
 * comment on the parent that @-mentions and re-dispatches its assignee.
 * CORRECTION (found on review, before verdict-synthesis-escalation was
 * dispatched): that dispatch targets whatever's ASSIGNED to the parent
 * issue inside Multica's own agent runtime -- a separate system from this
 * Node process. auriga/run.ts has no way to subscribe to or receive that
 * dispatch; it isn't a webhook or callback into this codebase. So
 * verdict-synthesis-escalation can NOT build its trigger on it directly --
 * it still needs to poll `issue children` itself (an in-process watcher-
 * style component, consistent with this whole epic's architecture), the
 * same way this class's own idempotency check does below. The "woken"
 * mechanism remains genuinely useful as a redundant, human/Multica-agent-
 * facing notification (whoever IS assigned to the parent in Multica gets a
 * real nudge), just not as this codebase's own synthesis trigger. This
 * class's own idempotency check (below) already polls `issue children`,
 * but for duplicate-creation avoidance, not completion detection --
 * verdict-synthesis-escalation's own poll serves the latter purpose.
 *
 * ## Verifier count N and assignee-selection strategy (this story's own
 * concrete decision, per its design_decisions note that this was left open
 * pending live research)
 *
 * Also discovered during the research step: `multica agent list` currently
 * returns exactly ONE agent registered against this project (pantheon-
 * orchestrator / Auriga) -- `auriga-dev`. The other two registered agents
 * in this workspace (`consus-dev`, `heimdall-dev`) work entirely different
 * repos and would be nonsensical verifier assignees here. There is also no
 * `multica member list` (or equivalent) command to enumerate other human
 * members to fall back on generically. In short: a real, independently-
 * provisioned pool of >=2 verifier identities for THIS project does not
 * exist yet in this Multica workspace.
 *
 * Given that gap, `verifierPool` is REQUIRED constructor config, with no
 * baked-in default -- mirroring `BoardStateWatcherConfig.projectId`'s
 * "required, not optional" precedent (auriga/watcher/index.ts) rather than
 * silently encoding a single, brittle, personal identity as a fake "pool of
 * one" default. N is then derived FROM the configured pool
 * (`verifierCount ?? verifierPool.length`, i.e. by default every configured
 * verifier gets exactly one sub-issue) rather than picked as an arbitrary
 * constant disconnected from what identities Multica can actually assign
 * distinctly -- this makes "N sub-issues, distinct assignees" true by
 * construction instead of something to separately reconcile. The
 * constructor validates the pool has no duplicate ids and that any
 * explicit `verifierCount` doesn't exceed the pool size, for the same
 * reason: an assignee can't be "distinct" from itself. A pool of exactly
 * one is technically accepted (no artificial floor enforced here -- a
 * caller-side deployment/ops decision, not this class's to gatekeep) but a
 * real N>=2 swarm requires provisioning at least 2 real verifier
 * identities in Multica for this project first, which is an operational
 * prerequisite outside this story's scope (see auriga/README.md's
 * verification-swarm section for the current pool status).
 *
 * ## Verdict recording convention (added on review, before verdict-synthesis-
 * escalation was dispatched -- this class originally created sub-issues
 * with no defined way for a verifier to record approve/reject, which would
 * have left the dependent story with nothing readable)
 *
 * Each sub-issue's own description instructs its verifier to record their
 * verdict by setting THAT SUB-ISSUE's status: `done` = approve, `blocked` =
 * reject. verdict-synthesis-escalation reads exactly this convention back
 * via `issue children` -- not a comment, not a label, so the read side has
 * one unambiguous field to check per verifier.
 *
 * ## Idempotency
 *
 * Every dispatch first calls `GET /api/issues/{parent}/children` (the same
 * endpoint `multica issue children` uses) and treats ANY existing children
 * as evidence a swarm was already dispatched for this parent, skipping
 * creation entirely and emitting `"swarm-skipped"` instead of
 * `"swarm-dispatched"`. This is checked against the live server on every
 * call -- not an in-memory "have I seen this issueId before" flag -- so it
 * survives exactly the watcher-restart scenario the story's acceptance
 * criteria call out (a fresh process/instance re-observing an
 * already-swarmed issue's review-eligible transition still sees the real
 * children and skips). An in-process per-issueId in-flight guard
 * (`#inFlight`, same shape as `MulticaLock`'s `#withTaskLock`,
 * auriga/lock/index.ts) additionally serializes overlapping calls for the
 * SAME issueId on the SAME instance, so two review-eligible events landing
 * back-to-back (before the first call's children-check has even resolved)
 * can't both race past that check and double-create.
 *
 * ## Parent status is never written
 *
 * This class only ever performs a GET (children check) and POSTs (sub-issue
 * creation) -- it has no method that PUTs/PATCHes the parent issue at all,
 * so the parent's status (`in_review`) is structurally never touched by
 * this component, satisfying this story's "parent status left as review,
 * unchanged" acceptance criterion by omission rather than by an explicit
 * guard that could be bypassed.
 */

export type VerifierAssigneeType = "agent" | "member" | "squad";

export interface VerifierPoolEntry {
  /** Multica assignee UUID (agent, member, or squad id). */
  id: string;
  type: VerifierAssigneeType;
}

export interface VerificationSwarmDispatcherConfig {
  serverUrl: string;
  workspaceId: string;
  /** Project sub-issues are created under -- passed straight through as
   * `project_id` on each created sub-issue, matching the parent's project
   * (this class does not fetch the parent to confirm; the composition root
   * wiring this dispatcher to a project-scoped BoardStateWatcher is
   * expected to configure both with the same projectId). */
  projectId: string;
  token: string;
  /**
   * Required, not optional -- see class doc's "Verifier count N and
   * assignee-selection strategy" section for why no default pool is baked
   * in here. Must contain at least one entry with unique `id`s.
   */
  verifierPool: readonly VerifierPoolEntry[];
  /** How many of the pool's verifiers get a sub-issue this dispatch.
   * Defaults to the whole pool (`verifierPool.length`) -- see class doc.
   * Must not exceed `verifierPool.length`. */
  verifierCount?: number;
}

export interface ReviewEligibleEvent {
  issueId: string;
  previousStatus?: string | undefined;
}

export interface SwarmDispatchedEvent {
  issueId: string;
  subIssueIds: string[];
}

export interface SwarmSkippedEvent {
  issueId: string;
  reason: "already-dispatched";
  existingChildCount: number;
}

export interface SwarmErrorEvent {
  issueId: string;
  error: unknown;
}

interface MulticaIssue {
  id: string;
  status: string;
  [key: string]: unknown;
}

/** Sub-issues created by this class always land in stage 1 -- this story
 * only builds ONE verification stage (the initial swarm); a future story
 * adding e.g. a re-verification stage would use stage 2+, not this
 * constant. */
const VERIFICATION_STAGE = 1;

export class VerificationSwarmDispatcher extends EventEmitter {
  readonly #serverUrl: string;
  readonly #workspaceId: string;
  readonly #projectId: string;
  readonly #token: string;
  readonly #verifierPool: readonly VerifierPoolEntry[];
  readonly #verifierCount: number;
  /** issueId -> in-flight dispatch promise, serializing overlapping calls
   * for the same parent on this instance. See class doc, "Idempotency". */
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(config: VerificationSwarmDispatcherConfig) {
    super();
    if (config.verifierPool.length === 0) {
      throw new Error("VerificationSwarmDispatcher: verifierPool must not be empty");
    }
    const uniqueIds = new Set(config.verifierPool.map((v) => v.id));
    if (uniqueIds.size !== config.verifierPool.length) {
      throw new Error(
        "VerificationSwarmDispatcher: verifierPool contains duplicate assignee ids -- every verifier must be distinct",
      );
    }
    const verifierCount = config.verifierCount ?? config.verifierPool.length;
    if (verifierCount < 1) {
      throw new Error("VerificationSwarmDispatcher: verifierCount must be >= 1");
    }
    if (verifierCount > config.verifierPool.length) {
      throw new Error(
        `VerificationSwarmDispatcher: verifierCount (${verifierCount}) exceeds verifierPool size (${config.verifierPool.length}) -- can't create more distinct assignees than the configured pool has`,
      );
    }

    this.#serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.#workspaceId = config.workspaceId;
    this.#projectId = config.projectId;
    this.#token = config.token;
    this.#verifierPool = config.verifierPool;
    this.#verifierCount = verifierCount;
  }

  /** Convenience wiring: listens for `watcher`'s `"review-eligible"` events
   * and dispatches a swarm for each, translating any rejection into a
   * `"swarm-error"` event rather than an unhandled rejection -- mirrors
   * BoardStateWatcher's own "poll-error", not "error" choice
   * (auriga/watcher/index.ts) for the same reason: EventEmitter throws
   * synchronously on an "error" event with no listener attached. */
  attach(watcher: EventEmitter): void {
    watcher.on("review-eligible", (event: ReviewEligibleEvent) => {
      this.handleReviewEligible(event).catch((error: unknown) => {
        this.emit("swarm-error", { issueId: event.issueId, error } satisfies SwarmErrorEvent);
      });
    });
  }

  /** Dispatches a verification swarm for `event.issueId`, or no-ops
   * (emitting `"swarm-skipped"`) if one already exists. Safe to call
   * directly (without `attach()`) for tests or alternative wiring. */
  async handleReviewEligible(event: ReviewEligibleEvent): Promise<void> {
    const { issueId } = event;
    const existing = this.#inFlight.get(issueId);
    if (existing) {
      // Another call for this exact issueId is already in flight on this
      // instance -- wait for it instead of racing a second children-check
      // past it. See class doc, "Idempotency".
      await existing;
      return;
    }

    const work = this.#dispatch(issueId);
    // Tracked as settled-not-rejecting so a failure here doesn't produce an
    // unhandled rejection from this Map entry itself; the real error still
    // propagates to this call's own caller via `await work` below.
    this.#inFlight.set(
      issueId,
      work.catch(() => undefined),
    );
    try {
      await work;
    } finally {
      this.#inFlight.delete(issueId);
    }
  }

  async #dispatch(issueId: string): Promise<void> {
    const existingChildren = await this.#getChildren(issueId);
    if (existingChildren.length > 0) {
      this.emit("swarm-skipped", {
        issueId,
        reason: "already-dispatched",
        existingChildCount: existingChildren.length,
      } satisfies SwarmSkippedEvent);
      return;
    }

    const assignees = this.#verifierPool.slice(0, this.#verifierCount);
    const subIssueIds: string[] = [];
    for (const [index, assignee] of assignees.entries()) {
      const subIssue = await this.#createSubIssue(issueId, assignee, index, assignees.length);
      subIssueIds.push(subIssue.id);
    }

    this.emit("swarm-dispatched", { issueId, subIssueIds } satisfies SwarmDispatchedEvent);
  }

  async #getChildren(parentId: string): Promise<MulticaIssue[]> {
    const url = this.#url(`/api/issues/${parentId}/children`);
    const res = await fetch(url, { headers: this.#headers() });
    if (!res.ok) {
      throw new Error(`VerificationSwarmDispatcher: GET ${url} -> ${res.status}`);
    }
    const body = (await res.json()) as { issues: MulticaIssue[] };
    return body.issues;
  }

  async #createSubIssue(
    parentId: string,
    assignee: VerifierPoolEntry,
    index: number,
    total: number,
  ): Promise<MulticaIssue> {
    const url = this.#url("/api/issues");
    const res = await fetch(url, {
      method: "POST",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        title: `Verify ${parentId} (verifier ${index + 1}/${total})`,
        description: `Independent verification sub-issue for parent issue ${parentId}, part of an N=${total}-verifier staged swarm dispatched by VerificationSwarmDispatcher on the parent's review-eligible transition. Multica's own stage-1-complete barrier (see auriga/watcher/verification-swarm.ts class doc) wakes the parent's assignee once all ${total} verifiers finish.

RECORD YOUR VERDICT BY SETTING THIS ISSUE'S OWN STATUS when you finish reviewing the parent's work (verdict-synthesis-escalation, the component that reads these back, relies on this exact convention -- do not use a comment or label instead):
  - Approve: set this issue's status to "done" (\`multica issue update <this-issue-id> --status done\`).
  - Reject / request changes: set this issue's status to "blocked" (\`multica issue update <this-issue-id> --status blocked\`).
Leave a comment explaining your reasoning either way -- the status is what synthesis reads programmatically, but the comment is what a human reads if this escalates.`,
        project_id: this.#projectId,
        parent_issue_id: parentId,
        stage: VERIFICATION_STAGE,
        assignee_type: assignee.type,
        assignee_id: assignee.id,
      }),
    });
    if (!res.ok) {
      throw new Error(`VerificationSwarmDispatcher: POST ${url} -> ${res.status}`);
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
}
