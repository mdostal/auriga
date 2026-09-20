#!/usr/bin/env node
// auriga/watcher/p2-verification-runner.ts — standalone runner for
// p2-acceptance-live-verification.yaml (board-state-machine epic). NOT a
// *.test.ts file, by design -- follows this repo's established convention
// for exactly this situation: auriga/escalation/e2e-runner.ts and
// auriga/consumer/restart-safety-runner.ts are both standalone scripts
// (spawned as real child processes, or run directly via `npx tsx`) that
// construct the REAL production classes but take every db/file path this
// story's own CRITICAL SAFETY REQUIREMENT cares about as an injectable
// argv, never touching the shared on-disk defaults.
//
// ## Why this exists instead of running auriga/run.ts a second time
//
// The operator has an ACTUAL, real P1 soak test effort in progress on this
// same machine (see p2-acceptance-live-verification.yaml's own "CRITICAL
// SAFETY REQUIREMENT" section). auriga/run.ts's HeartbeatWriter/
// ObservabilityCounterStore/DeathEventStore/escalations SqliteDBAdapter all
// resolve to FIXED, shared, gitignored file paths with NO override
// (auriga/observability/heartbeat.json, counters.db, death-events.db,
// auriga/escalation/escalations.db) -- running `tsx auriga/run.ts` a second
// time, or constructing any of those classes with no path override, risks
// corrupting or interleaving with that real run. This script never imports
// auriga/run.ts (importing it would execute its top-level `main().catch()`
// call immediately -- there is no side-effect-free way to import it) and
// never constructs HeartbeatWriter/DeathEventStore at all -- this story's
// acceptance criteria don't need either (no death-detection concern here,
// this is a short supervised run, not an unattended multi-hour one). The
// two stores this script DOES need (ObservabilityCounterStore, an
// escalations SqliteDBAdapter) are both given explicit paths via argv,
// pointed at a fresh temp directory the caller (see the runbook) creates
// and controls -- never this module's or run.ts's own default.
//
// This script DOES talk to REAL, LIVE Multica project Auriga -- unlike
// e2e-runner.ts's deliberately-unreachable-endpoint trick (a different
// story's concern), only the PERSISTENCE paths are isolated here, not the
// Multica server itself. Config is read fresh from ~/.multica/config.json
// via loadMulticaConfig(), the same convention every other live-Multica
// component in this repo uses (auriga/adapters/multica/index.ts).
//
// ## What this script wires (a deliberately narrower composition than
// run.ts's full five-loop entrypoint)
//
// Only what p2-acceptance-live-verification.yaml's two acceptance criteria
// need, both loops this epic's stories built:
//   - MulticaLock -> InstrumentedLock -> AurigaConsumer (P1's claim/dispatch
//     chain), fed by BoardStateWatcher's "dispatch-eligible" events via
//     wireDispatchEligible() -- the auto-dispatch loop.
//   - BoardStateWatcher's "review-eligible" events -> VerificationSwarmDispatcher
//     (creates the verifier sub-issues) -- and, independently,
//     VerdictSynthesizer's own poll loop, which reads those sub-issues'
//     terminal statuses back and resolves the parent -- the
//     verification-swarm-through-synthesis loop.
//   - InstrumentedWatcher / InstrumentedVerdictSynthesizer, the same
//     observability decorators run.ts's own composition root uses, feeding
//     the SAME ObservabilityCounterStore instance (pointed at this script's
//     injected countersDbPath) so results are queryable afterward exactly
//     the way p1-soak-test-run's own report was.
//
// Deliberately NOT wired: the synthetic workload generator (run.ts's
// own P1-era traffic generator -- this story creates its own real test
// issues by hand, per the runbook), the sweep loop (not needed for a short
// run touching a handful of issues), and SustainedDeclineDetector /
// HeartbeatWriter / DeathEventStore (P1 death/escalation-on-failure
// concerns, out of this story's scope and exactly the components the
// safety requirement above says must never be pointed at a default path --
// simplest to not construct them at all rather than carry the risk of a
// future edit accidentally omitting their path override).
//
// ## verifierPool
//
// PAN-5578 provisioned two dedicated Auriga verifier agents and centralized
// them in `auriga/watcher/verifier-pool.ts`. This runner uses that same pool
// as the production composition root, so a live review-eligible issue creates
// N=2 sub-issues assigned to two distinct agent identities rather than the
// earlier operator-member stand-in used during the first P2 acceptance run.
//
// ## Usage
//
//   npx tsx auriga/watcher/p2-verification-runner.ts <countersDbPath> <escalationsDbPath> [pollIntervalMs] [mode]
//
// `mode` is `full` (default) or `verdict-only`. Runs until SIGINT/SIGTERM
// (Ctrl-C), at which point it stops whatever loops it started cleanly
// (awaiting any in-flight poll), does one final counters/verdicts persist,
// closes both sqlite handles, and exits 0. Prints one status line per tick
// (mirroring run.ts's own `[status]` line shape) plus a line for every
// interesting event, so a supervising operator can correlate real `multica`
// CLI actions (creating test issues, flipping sub-issue statuses) against
// what this process actually observes, live.
//
// ## `verdict-only` mode -- a real gap discovered while first running this
// script live (kept as a permanent, documented safety option, not removed
// once worked around)
//
// `BoardStateWatcher` (auriga/watcher/index.ts) has no "cold start"
// concept: on a FRESH instance's first poll, EVERY issue currently sitting
// in `todo`/`in_review` in the whole watched project is treated as a brand
// new transition (previousStatus undefined, differs from the current
// status -- see that class's own "Exactly-once per transition" doc), not
// just issues that transitioned AFTER the watcher started. Running the
// `full` mode against project Auriga for real, for the first time, hit this
// immediately: it auto-dispatched against this epic's OWN pre-existing
// `todo`-status tracking issues (the epic parent and its deliberately-
// unassigned, gated stage-7 sub-issue) and dispatched a real verification
// swarm against PAN-3881 (a long-standing `in_review` historical fixture
// issue, unrelated to this run) purely because they happened to already be
// sitting in an eligible status when the watcher's first poll ran. All of
// that was manually identified and reverted/cleaned up as part of this
// story's own verification (see p2-verification-report.md) -- this is a
// real, load-bearing finding this story's risk section anticipated
// ("integration-level surprises... [tests] may not catch"), not a defect in
// this runner, and is exactly the kind of thing a short, supervised,
// human-watched run (per this story's own design) is FOR catching before
// production use. See p2-verification-report.md's "Discovered gap" section
// for the suggested follow-up story.
//
// `verdict-only` mode is this script's own mitigation for finishing the
// REST of a verification run safely once that cold-start side effect has
// already been cleaned up once: it constructs ONLY `VerdictSynthesizer` (no
// `MulticaLock`/`AurigaConsumer`/`BoardStateWatcher`/`wireDispatchEligible`/
// `VerificationSwarmDispatcher` at all), so it cannot claim/dispatch
// anything or create a new swarm against ANY issue -- it can only resolve
// (approve or escalate) `in_review` parents that ALREADY have terminal
// (`done`/`blocked`) children, which is exactly and only the second half of
// this story's own verification (setting sub-issue statuses, then letting
// synthesis resolve them) once the swarms themselves are already dispatched
// from an earlier `full`-mode run.
import { MulticaLock } from "../lock/index.ts";
import { MulticaTrackerAdapter, loadMulticaConfig } from "../adapters/multica/index.ts";
import { AurigaConsumer, type ClassifiedFailure } from "../consumer/index.ts";
import { InstrumentedLock } from "../observability/instrumented-lock.ts";
import { deriveTransitionVerdictCounts, ObservabilityCounterStore } from "../observability/counters.ts";
import { InstrumentedWatcher } from "../observability/instrumented-watcher.ts";
import { InstrumentedVerdictSynthesizer } from "../observability/instrumented-verdict-synthesizer.ts";
import { BoardStateWatcher } from "./index.ts";
import { wireDispatchEligible } from "./dispatch-wiring.ts";
import {
  VerificationSwarmDispatcher,
  type SwarmDispatchedEvent,
  type SwarmSkippedEvent,
  type SwarmErrorEvent,
} from "./verification-swarm.ts";
import { AURIGA_VERIFIER_POOL } from "./verifier-pool.ts";
import { VerdictSynthesizer, type VerdictApprovedEvent, type VerdictEscalatedEvent } from "./verdict-synthesis.ts";
import { SqliteDBAdapter } from "../adapters/db/index.ts";

/** Same live project id auriga/run.ts's own composition root uses
 * (`WATCHER_PROJECT_ID`) -- re-declared here, not imported, because
 * importing run.ts would execute its top-level `main().catch()` call
 * immediately (see this file's header doc). Auriga's own live Multica
 * project id -- fixed, not env-overridable, matching BoardStateWatcher's
 * and VerdictSynthesizer's own "required, not optional" project scoping. */
const WATCHER_PROJECT_ID = "d78a9f5d-8792-45e8-89e0-bd7b916564ca";

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h${m}m${s}s`;
}

type Mode = "full" | "verdict-only";

async function main(): Promise<void> {
  const countersDbPath = process.argv[2];
  const escalationsDbPath = process.argv[3];
  const pollIntervalMs = process.argv[4] ? Number(process.argv[4]) : 5_000;
  const modeArg = process.argv[5] ?? "full";

  if (!countersDbPath || !escalationsDbPath) {
    console.error(
      "usage: p2-verification-runner.ts <countersDbPath> <escalationsDbPath> [pollIntervalMs] [mode: full|verdict-only]",
    );
    process.exit(2);
  }
  if (modeArg !== "full" && modeArg !== "verdict-only") {
    console.error(`p2-verification-runner: unknown mode "${modeArg}" -- expected "full" or "verdict-only"`);
    process.exit(2);
  }
  const mode: Mode = modeArg;

  const cfg = loadMulticaConfig();

  console.log(
    `[p2-verify] mode=${mode} loaded config: server=${cfg.server_url} workspace=${cfg.workspace_id} ` +
      `project=${WATCHER_PROJECT_ID} verifierPool=${JSON.stringify(AURIGA_VERIFIER_POOL)}`,
  );
  console.log(`[p2-verify] countersDbPath=${countersDbPath} escalationsDbPath=${escalationsDbPath} pollIntervalMs=${pollIntervalMs}`);

  const trackerAdapter = new MulticaTrackerAdapter(cfg);

  // --- Isolated observability stores (NEVER the shared defaults -- see header doc) ---
  const counterStore = new ObservabilityCounterStore(countersDbPath);
  const escalationsDbAdapter = new SqliteDBAdapter(escalationsDbPath);

  // --- `full` mode only: real P1 chain + watcher + swarm dispatcher.
  // See header doc, "verdict-only mode", for why `verdict-only` constructs
  // none of this -- it must be structurally incapable of claiming/dispatching
  // anything or creating a new swarm against ANY issue in the project. ---
  let instrumentedWatcher: InstrumentedWatcher | undefined;
  let watcher: BoardStateWatcher | undefined;
  if (mode === "full") {
    const realLock = new MulticaLock({
      serverUrl: cfg.server_url,
      workspaceId: cfg.workspace_id,
      token: cfg.token,
    });
    const instrumentedLock = new InstrumentedLock(realLock);
    const consumer = new AurigaConsumer(instrumentedLock, trackerAdapter);
    await consumer.start();
    consumer.on("failure", (failure: ClassifiedFailure) => {
      console.log(
        `[p2-verify] CONSUMER-FAILURE ${JSON.stringify({ errorType: failure.errorType, sourceAdapter: failure.sourceAdapter, taskId: failure.taskId })}`,
      );
    });

    watcher = new BoardStateWatcher({
      serverUrl: cfg.server_url,
      workspaceId: cfg.workspace_id,
      projectId: WATCHER_PROJECT_ID,
      token: cfg.token,
      pollIntervalMs,
    });
    wireDispatchEligible(watcher, consumer);
    watcher.on("poll-error", (error: unknown) => {
      console.error("[p2-verify] watcher poll-error:", error);
    });
    instrumentedWatcher = new InstrumentedWatcher(watcher);
    instrumentedWatcher.on("event", (event) => {
      console.log(`[p2-verify] TRANSITION ${JSON.stringify(event)}`);
    });

    const swarmDispatcher = new VerificationSwarmDispatcher({
      serverUrl: cfg.server_url,
      workspaceId: cfg.workspace_id,
      projectId: WATCHER_PROJECT_ID,
      token: cfg.token,
      verifierPool: AURIGA_VERIFIER_POOL,
    });
    swarmDispatcher.attach(watcher);
    swarmDispatcher.on("swarm-dispatched", (event: SwarmDispatchedEvent) => {
      console.log(`[p2-verify] SWARM-DISPATCHED ${JSON.stringify(event)}`);
    });
    swarmDispatcher.on("swarm-skipped", (event: SwarmSkippedEvent) => {
      console.log(`[p2-verify] SWARM-SKIPPED ${JSON.stringify(event)}`);
    });
    swarmDispatcher.on("swarm-error", (event: SwarmErrorEvent) => {
      console.error(`[p2-verify] SWARM-ERROR ${JSON.stringify(event)}`);
    });
  } else {
    console.log(
      "[p2-verify] verdict-only mode: no MulticaLock/AurigaConsumer/BoardStateWatcher/" +
        "VerificationSwarmDispatcher constructed -- this process cannot claim, dispatch, " +
        "or create a swarm against anything; it can only resolve already-dispatched swarms.",
    );
  }

  // --- Verdict synthesizer: its own poll loop, reads swarm verdicts back
  // and resolves them (done, or an EscalationRecord). Constructed in BOTH
  // modes -- this is the one loop `verdict-only` mode exists to run safely
  // on its own. ---
  const verdictSynthesizer = new VerdictSynthesizer({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    projectId: WATCHER_PROJECT_ID,
    token: cfg.token,
    trackerAdapter,
    dbAdapter: escalationsDbAdapter,
    pollIntervalMs,
  });
  verdictSynthesizer.on("poll-error", (error: unknown) => {
    console.error("[p2-verify] verdict-synthesis poll-error:", error);
  });
  verdictSynthesizer.on("verdict-approved", (event: VerdictApprovedEvent) => {
    console.log(`[p2-verify] VERDICT-APPROVED ${JSON.stringify(event)}`);
  });
  verdictSynthesizer.on("verdict-escalated", (event: VerdictEscalatedEvent) => {
    console.log(`[p2-verify] VERDICT-ESCALATED ${JSON.stringify(event)}`);
  });
  const instrumentedVerdictSynthesizer = new InstrumentedVerdictSynthesizer(verdictSynthesizer);
  instrumentedVerdictSynthesizer.on("event", (event) => {
    console.log(`[p2-verify] VERDICT-EVENT ${JSON.stringify(event)}`);
  });

  watcher?.start();
  verdictSynthesizer.start();

  const startedAt = Date.now();

  // --- Periodic persist + status line (same "re-derive over full
  // accumulated history each tick, idempotent via INSERT OR IGNORE"
  // reasoning as run.ts's own countersTimer -- see that file's header doc). ---
  const statusTimer = setInterval(() => {
    try {
      if (instrumentedWatcher) counterStore.recordTransitions(instrumentedWatcher.events);
      counterStore.recordVerdicts(instrumentedVerdictSynthesizer.events);
      const counts = deriveTransitionVerdictCounts([
        ...(instrumentedWatcher?.events ?? []),
        ...instrumentedVerdictSynthesizer.events,
      ]);
      console.log(
        `[p2-verify] [status] uptime=${formatUptime(Date.now() - startedAt)} ` +
          `transitionsFired=${counts.transitionsFired} swarmsDispatched=${counts.swarmsDispatched} ` +
          `unanimousApprove=${counts.unanimousApproveCount} escalations=${counts.escalationCount}`,
      );
    } catch (error) {
      console.error("[p2-verify] [status] persist failed:", error);
    }
  }, pollIntervalMs);

  let stopping = false;
  const handleSignal = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[p2-verify] received ${signal} -- stopping cleanly`);
    clearInterval(statusTimer);
    void Promise.all([watcher?.stop() ?? Promise.resolve(), verdictSynthesizer.stop()])
      .then(() => {
        // Final persist so nothing observed between the last tick and stop() is lost.
        if (instrumentedWatcher) counterStore.recordTransitions(instrumentedWatcher.events);
        counterStore.recordVerdicts(instrumentedVerdictSynthesizer.events);
        console.log("[p2-verify] final persist complete");
      })
      .finally(() => {
        counterStore.close();
        escalationsDbAdapter.close();
        console.log("[p2-verify] stores closed, exiting 0");
        process.exit(0);
      });
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  console.log(
    `[p2-verify] p2-verification-runner started. pid=${process.pid} workspace=${cfg.workspace_id} ` +
      `project=${WATCHER_PROJECT_ID} pollIntervalMs=${pollIntervalMs} mode=${mode}`,
  );
}

main().catch((error) => {
  console.error("[p2-verify] fatal startup error:", error);
  process.exit(1);
});
