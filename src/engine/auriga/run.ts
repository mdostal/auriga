#!/usr/bin/env node
// auriga/run.ts — the real, deployable process entrypoint this epic has
// been missing (see .pHive/epics/contracts-and-spine/docs/process-supervision.md,
// "there is no process to supervise yet" and its `steps.implement` scope
// note naming exactly this file as the interim procedure's missing piece).
// Built for p1-soak-test-run.yaml's prep work: wires every real
// implementation this epic has produced into one long-running process a
// human can `tsx auriga/run.ts` inside `tmux`/`nohup` (per
// process-supervision.md's "no supervisor, manual restart only" decision)
// and let run unattended for the actual 24-48h P1 soak test.
//
// This script is pure composition of earlier stories' real implementations
// (real MulticaLock + InstrumentedLock + real MulticaTrackerAdapter + real
// AurigaConsumer + real SustainedDeclineDetector + real HeartbeatWriter +
// real ObservabilityCounterStore + real BoardStateWatcher + real
// VerdictSynthesizer + real InstrumentedWatcher/InstrumentedVerdictSynthesizer
// -- observability-transition-verdict-counters.yaml's own InstrumentedLock-
// style decorators around the watcher/synthesizer above, persisting into
// the SAME ObservabilityCounterStore instance), plus two small, genuinely
// new pieces, since nothing else in this epic originates real
// claimable-work events — AurigaConsumer.onEvent() is only ever invoked
// externally, by design (see its own class doc):
//   - a synthetic workload generator (see "Synthetic workload" section
//     below), P1-era, kept as-is;
//   - auto-dispatch-wiring's own event-shape translation function
//     (auriga/watcher/dispatch-wiring.ts's `wireDispatchEligible`/
//     `toDispatchEvent`), which turns BoardStateWatcher's real
//     "dispatch-eligible" transitions into onEvent() calls too (see "Board-
//     state watcher" section below). Both sources are additive, feeding the
//     SAME onEvent() path side by side — see design-discussion.md 5a
//     resolution 4;
//   - `VerificationSwarmDispatcher`, which turns BoardStateWatcher's real
//     "review-eligible" transitions into N=2 staged verifier sub-issues
//     using the dedicated Auriga verifier pool.
//
// ## Why the process stays alive without an artificial busy-loop
//
// process-supervision.md's own sketch of this entrypoint asks for "an
// event-driven consumer loop that naturally stays alive on its own
// listeners -- no artificial setInterval busy-loop needed". This script
// honors that spirit but not literally: AurigaConsumer itself has no
// listen loop (see its class doc -- onEvent() is externally invoked), so
// SOMETHING has to originate work for a soak test to exercise anything at
// all. That something is the three real, low-frequency `setInterval`
// timers below (workload generation, sweep, counters-derivation) -- each
// doing genuine periodic work, not a meaningless spin loop. They are
// DELIBERATELY NOT `.unref()`d (unlike `HeartbeatWriter`'s own internal
// timer, which the death-detection module unrefs so a caller that forgets
// cleanup doesn't hang forever) -- these three timers are exactly what
// keeps this process's event loop alive for the whole 24-48h run. If they
// were unref'd too, the process would have nothing left holding it open
// the moment `main()` returns and would exit immediately after startup,
// which is exactly wrong for a long-running soak test.
//
// ## staleMs -- why 60s, not the 5-minute production default
//
// MulticaLock's own default `staleMs` (auriga/lock/index.ts,
// DEFAULT_STALE_MS) is 5 minutes -- a documented guess for how long a REAL
// task's work might legitimately take before a held lease should be
// considered abandoned. That default is the wrong choice for the
// synthetic workload this script drives: each simulated "task" here does
// no real work at all (claim + one tracker-adapter PUT, then nothing) --
// there is no legitimate reason for its lease to stay open for minutes.
// Using a SHORT override (60_000ms) lets `sweep()` reclaim each
// completed synthetic task's lease promptly, which `InstrumentedLock`
// records as a `"released"` event -- matching `counters.ts`'s own
// documented equivalence between an explicit release() and a
// sweep-reclaim (see LockEvent's doc comment, "released" variant). This
// value is deliberately kept comfortably SHORTER than
// `DEFAULT_DROPPED_WINDOW_MS` (5 minutes, auriga/observability/counters.ts)
// so a healthy sweep cycle always marks a synthetic task released well
// before observability's dropped-window would ever flag it as abandoned --
// otherwise every single synthetic task would trivially violate the
// soak test's own 0-dropped-tasks pass bar, which would make the bar
// meaningless rather than a real signal. See SWEEP_INTERVAL_MS below for
// how the sweep cadence keeps this margin real, not just nominal.
//
// ## Synthetic workload -- why it pre-creates a REAL Multica issue per task
//
// The obvious design -- generate a random taskId string and hand it
// straight to `consumer.onEvent()` -- was tried first and rejected. Two
// established precedents in this repo already document exactly what
// happens if you do that against LIVE Multica:
//   - MulticaLock auto-provisions its OWN separate Multica issue for any
//     taskId it has never seen (see its class doc, "taskId -> Multica
//     issue mapping"), so `lock.claim(taskId)` always succeeds regardless
//     of whether `taskId` is a pre-existing real issue.
//   - MulticaTrackerAdapter treats `taskId` as a Multica issue id
//     DIRECTLY (`PUT /api/issues/${taskId}`) with no auto-provisioning of
//     its own. A random/synthetic taskId that isn't already a real issue
//     404s. `auriga/consumer/restart-safety-runner.ts`'s own header doc
//     calls this out explicitly as "expected/harmless" for that script's
//     one-shot use -- caught by AurigaConsumer's error boundary, emitted
//     as a `"failure"` event, process survives.
// "Expected/harmless" for a single one-off test run is NOT harmless for
// this script: every such failure feeds `SustainedDeclineDetector`, and
// this script intentionally runs with PRODUCTION escalation defaults (5
// failures / 60s window -- see "Escalation" section below). A synthetic
// workload that reliably 404s on every dispatch would cross that
// threshold within the first few ticks and escalate-and-stop the real
// 24-48h run almost immediately -- defeating the entire point of running
// it. So `#createSyntheticTrackerIssue` below directly POSTs a real
// Multica issue (same auth/fetch pattern every live test in this repo
// uses) BEFORE calling `consumer.onEvent()`, and uses THAT issue's real id
// as the event's taskId. This makes `trackerAdapter.updateStatus()`
// succeed against a real, existing issue every time, while
// `lock.claim()` still auto-provisions its own separate internal
// "lock-impl-dev: <taskId>" tracking issue exactly as documented --  two
// Multica issues per synthetic task is an accepted, documented cost of
// exercising the real chain end-to-end without fabricating failures the
// production escalation threshold would (correctly) act on. Both issue
// sets are tracked (`#preCreatedTaskIssueIds` here, `realLock.createdIssueIds`
// on the unwrapped MulticaLock) and logged on shutdown for cleanup.
//
// ## Workload/sweep/counters cadence
//
// - WORKLOAD_INTERVAL_MS (default 60s): gentle on a live, shared Multica
//   instance over a 24-48h window (README.md: "Fresh on dostal@hive...
//   never live on it") while still producing a meaningful sample --
//   ~1,440 synthetic tasks over 24h, ~2,880 over 48h -- comfortably more
//   than enough to make a 0/0/0 pass bar a real signal rather than a
//   fluke of small sample size. Each tick performs 1 issue-creation POST +
//   MulticaLock's internal claim traffic (1 POST + 2 GET + 1 PUT) +
//   trackerAdapter's 1 PUT -- 6 HTTP calls/minute at steady state, trivial
//   load for a live server.
// - SWEEP_INTERVAL_MS (default 30s): comfortably more frequent than
//   staleMs (60s) -- roughly 2 sweep ticks per stale window -- so a
//   completed synthetic task's lease is reclaimed (and recorded
//   "released") within, worst case, ~90s of being claimed: well inside
//   the 5-minute dropped-task window.
// - COUNTERS_INTERVAL_MS (default 60s): how often `deriveCounters()` runs
//   and persists to `ObservabilityCounterStore`. See `#deriveAndPersist`
//   below for why it re-derives over InstrumentedLock's FULL accumulated
//   event history each time rather than just new-since-last-tick events.
//
// All four intervals (plus lock staleMs and the escalation threshold/
// window) are env-overridable for testability -- production callers
// should never need to set any of them; see the `AURIGA_*` env vars
// documented at each constant below. (WATCHER_POLL_INTERVAL_MS, the fifth
// interval this story adds, follows the same env-override convention --
// see "Board-state watcher" below.)
//
// ## Board-state watcher -- the fourth interval loop (auto-dispatch-wiring)
//
// `auriga/watcher/index.ts`'s `BoardStateWatcher` polls live Multica for
// board-state transitions and emits "dispatch-eligible"/"review-eligible"
// events but calls nothing itself (by design -- see its own class doc,
// "detects and emits ONLY"). This story wires its "dispatch-eligible"
// events into the SAME `consumer.onEvent()` path the synthetic workload
// generator above already drives, via `auriga/watcher/dispatch-wiring.ts`'s
// `wireDispatchEligible()` -- a second, REAL event source feeding the P1
// claim -> lock -> mark in_progress -> hand-off chain, additive to (not a
// replacement of) the synthetic generator (design-discussion.md 5a
// resolution 4: "the watcher becomes a fourth interval-based loop in the
// same entrypoint, not a new process").
//
// Its `"review-eligible"` events are wired to `VerificationSwarmDispatcher`,
// which creates N staged verifier sub-issues assigned from
// `AURIGA_VERIFIER_POOL`; `VerificationSwarmDispatcher` defaults N to pool
// length, so the production path dispatches one verifier sub-issue per
// dedicated verifier identity.
//
// `BoardStateWatcher` manages its own self-scheduling poll loop internally
// (see its class doc, "Poll loop shape") -- this script does not wrap it in
// an additional `setInterval`; calling `watcher.start()` IS the fourth
// interval-based loop, running in this same process alongside the
// workload/sweep/counters timers.
//
// `WATCHER_PROJECT_ID` is Auriga's own live Multica project id (fixed, not
// env-overridable -- there is exactly one real project this process should
// ever watch; see `BoardStateWatcher`'s own class doc, "Project scoping",
// for why an unscoped watcher is unsafe). `WATCHER_POLL_INTERVAL_MS` is
// `undefined` unless overridden, letting `BoardStateWatcher` fall back to
// its own real default (30s, per design-discussion.md 5a resolution 1) --
// same `envIntOrUndefined` pattern as the escalation knobs above, for the
// same reason: this constant must not duplicate-and-drift from the class's
// own default.
//
// ## Escalation wiring -- the "future work" this script IS
//
// `auriga/escalation/index.ts`'s own class doc and
// `auriga/observability/death-detection.ts`'s own "Wiring into
// SustainedDeclineDetector" section both describe, as explicitly deferred
// future work, calling `heartbeatWriter.markCleanShutdown()` as the FIRST
// step of a real stop path, before the real `process.exit()`. This script
// is that future work: the `stop` function injected into
// `SustainedDeclineDetector` below does exactly that, in that order, so a
// heartbeat file belonging to an escalated run always carries
// `cleanShutdownAt` before the process actually exits -- which is what
// lets `detectPreviousDeath()` on the NEXT run correctly distinguish "the
// previous run escalated on purpose" from "the previous run died".
//
// Escalation itself runs with PRODUCTION defaults (5 failures / 60s
// window, `auriga/escalation/index.ts`'s own `DEFAULT_THRESHOLD_COUNT`/
// `DEFAULT_WINDOW_MS`) for the real 24-48h run -- NOT overridden here.
// `AURIGA_ESCALATION_THRESHOLD`/`AURIGA_ESCALATION_WINDOW_MS` env vars
// exist purely so a short, deliberate smoke run can prove the stop-wiring
// actually fires end-to-end (see this story's own verification step)
// without waiting for 5 real failures to occur naturally; both default to
// `undefined`, which lets `SustainedDeclineDetector` fall back to its own
// real production constants.
//
// ## SIGINT/SIGTERM -- a human-initiated stop is a clean stop, not a death
//
// A human running this in a `tmux` pane needs a way to end a run on
// purpose (end of the 24-48h window, or ending a short smoke run) without
// that stop being misread as a crash by the NEXT run's `detectPreviousDeath()`
// check. SIGINT/SIGTERM handlers below stop the board-state watcher first
// (awaiting its in-flight poll, if any -- see `BoardStateWatcher.stop()`'s
// own class doc), THEN call the same `stop()` path escalation uses
// (`markCleanShutdown()` then `process.exit(0)`), logging both tracked
// issue-id sets first so a human (or this story's own smoke test) can clean
// them up. Per process-supervision.md's own note, this is
// NOT the same thing as "the process died mid-run and a human restarted
// it" -- a human deliberately ending a run (e.g. concluding the soak test
// window) is an intentional stop; a human restarting a run that died or
// was killed mid-window is the case process-supervision.md says must be
// recorded as a soak-test failure. See the runbook for the distinction in
// practice.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MulticaLock } from "./lock/index.ts";
import { MulticaTrackerAdapter, loadMulticaConfig, type MulticaConfig } from "./adapters/multica/index.ts";
import { AurigaConsumer, type ClassifiedFailure } from "./consumer/index.ts";
import { SustainedDeclineDetector, type EscalationRecord } from "./escalation/index.ts";
import { InstrumentedLock } from "./observability/instrumented-lock.ts";
import { deriveCounters, deriveTransitionVerdictCounts, ObservabilityCounterStore } from "./observability/counters.ts";
import { HeartbeatWriter, detectPreviousDeath, DeathEventStore } from "./observability/death-detection.ts";
import { InstrumentedWatcher } from "./observability/instrumented-watcher.ts";
import { InstrumentedVerdictSynthesizer } from "./observability/instrumented-verdict-synthesizer.ts";
import { BoardStateWatcher } from "./watcher/index.ts";
import { wireDispatchEligible } from "./watcher/dispatch-wiring.ts";
import { VerificationSwarmDispatcher } from "./watcher/verification-swarm.ts";
import { AURIGA_VERIFIER_POOL } from "./watcher/verifier-pool.ts";
import { VerdictSynthesizer } from "./watcher/verdict-synthesis.ts";
import { SqliteDBAdapter } from "./adapters/db/index.ts";
import type { EventContract } from "../contracts/event.ts";

/** Reads a positive-integer env var override, falling back to `fallback` if unset/invalid. */
function envIntMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Reads an optional positive-integer env var override; `undefined` (not a fallback number) lets the
 * downstream class fall back to ITS OWN real default -- used for the two escalation knobs and the
 * watcher's poll interval, all three of which must default to their OWN class's real production
 * constant, not a value duplicated (and liable to drift) here. */
function envIntOrUndefined(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// See header doc, "staleMs" / cadence sections, for the rationale behind every default below.
const LOCK_STALE_MS = envIntMs("AURIGA_LOCK_STALE_MS", 60_000);
const WORKLOAD_INTERVAL_MS = envIntMs("AURIGA_WORKLOAD_INTERVAL_MS", 60_000);
const SWEEP_INTERVAL_MS = envIntMs("AURIGA_SWEEP_INTERVAL_MS", 30_000);
const COUNTERS_INTERVAL_MS = envIntMs("AURIGA_COUNTERS_INTERVAL_MS", 60_000);
const ESCALATION_THRESHOLD_COUNT = envIntOrUndefined("AURIGA_ESCALATION_THRESHOLD");
const ESCALATION_WINDOW_MS = envIntOrUndefined("AURIGA_ESCALATION_WINDOW_MS");
/** `undefined` unless overridden -- lets BoardStateWatcher fall back to its own 30s default.
 * See header doc, "Board-state watcher". */
const WATCHER_POLL_INTERVAL_MS = envIntOrUndefined("AURIGA_WATCHER_POLL_INTERVAL_MS");
/** Auriga's own live Multica project id -- fixed, not env-overridable. See header doc,
 * "Board-state watcher", for why this watcher must stay scoped to exactly this one project.
 * Exported so a composition test can pre-seed a fake issue under the SAME id run.ts's own
 * watcher will actually poll for, without duplicating the literal and risking drift. */
export const WATCHER_PROJECT_ID = "d78a9f5d-8792-45e8-89e0-bd7b916564ca";

/** Sibling db file to auriga/observability/counters.ts, following that module's own
 * DEFAULT_DB_PATH/DEFAULT_HEARTBEAT_PATH "alongside this module" convention. */
const COUNTERS_DB_PATH = fileURLToPath(new URL("./observability/counters.db", import.meta.url));

/** The SAME db file auriga/escalation/index.ts's SustainedDeclineDetector
 * writes to by default (its own internal DEFAULT_DB_PATH, not exported --
 * recomputed here from run.ts's own location so both escalation sources
 * land in one file, one queryable source of truth for a human or Consus,
 * per verdict-synthesis-escalation's own "reuse EscalationRecord, don't
 * fragment" design decision extended to the storage location too.
 * VerdictSynthesizerConfig requires an explicit dbAdapter (unlike
 * SustainedDeclineDetectorOptions' optional one with an internal default),
 * so run.ts constructs it explicitly here rather than relying on a
 * same-named-but-different default drifting out of sync. */
const ESCALATIONS_DB_PATH = fileURLToPath(new URL("./escalation/escalations.db", import.meta.url));

const processStartedAt = Date.now();

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h${m}m${s}s`;
}

/** Directly POSTs a real Multica issue and returns its id -- see header doc,
 * "Synthetic workload -- why it pre-creates a REAL Multica issue per task". */
async function createSyntheticTrackerIssue(cfg: MulticaConfig, title: string): Promise<string> {
  const url = `${cfg.server_url.replace(/\/+$/, "")}/api/issues?workspace_id=${cfg.workspace_id}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error(`createSyntheticTrackerIssue: POST ${url} -> ${res.status}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function main(): Promise<void> {
  const cfg = loadMulticaConfig();
  // TEST-ONLY override: lets a verification run point MulticaLock/
  // MulticaTrackerAdapter at an unreachable endpoint (e.g. the same
  // `http://127.0.0.1:1` technique auriga/escalation/e2e-runner.ts uses)
  // WITHOUT touching the real ~/.multica/config.json on disk. Unset in
  // every normal/production run -- this exists purely so this story's own
  // escalation-wiring smoke verification (a real process, a real
  // SustainedDeclineDetector, a real exit) can be driven against a
  // guaranteed-failing endpoint on demand.
  if (process.env.AURIGA_MULTICA_SERVER_URL_OVERRIDE) {
    cfg.server_url = process.env.AURIGA_MULTICA_SERVER_URL_OVERRIDE;
    console.log(`[run] AURIGA_MULTICA_SERVER_URL_OVERRIDE set -- using ${cfg.server_url} instead of the configured server_url (test-only)`);
  }

  // --- Death attribution: read the PRIOR run's heartbeat file BEFORE this
  // run's own HeartbeatWriter overwrites it. This is attribution
  // bookkeeping about the PAST, not a new failure for this run -- it must
  // never block or otherwise affect this run's own startup (see
  // death-detection.ts's own doc, "Distinguishing clean-shutdown from
  // death").
  const priorDeath = detectPreviousDeath();
  const deathEventStore = new DeathEventStore();
  if (priorDeath.death) {
    console.log(
      `[run] PRIOR RUN DIED (attribution, not a new failure): ${JSON.stringify(priorDeath.event)}`,
    );
    deathEventStore.recordDeath(priorDeath.event);
  } else {
    console.log(`[run] prior-run check: ${priorDeath.reason}`);
  }

  const heartbeatWriter = new HeartbeatWriter(); // default interval (30s), default path
  heartbeatWriter.start();
  console.log(`[run] heartbeat started: runId=${heartbeatWriter.runId} path=${heartbeatWriter.heartbeatPath}`);

  // --- Real chain: MulticaLock (short staleMs) -> InstrumentedLock -> AurigaConsumer ---
  const realLock = new MulticaLock({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    token: cfg.token,
    staleMs: LOCK_STALE_MS,
  });
  const trackerAdapter = new MulticaTrackerAdapter(cfg);
  const instrumentedLock = new InstrumentedLock(realLock);
  const consumer = new AurigaConsumer(instrumentedLock, trackerAdapter);
  await consumer.start();

  consumer.on("failure", (failure: ClassifiedFailure) => {
    console.log(
      `[run] FAILURE ${JSON.stringify({ errorType: failure.errorType, sourceAdapter: failure.sourceAdapter, taskId: failure.taskId })}`,
    );
  });

  const counterStore = new ObservabilityCounterStore(COUNTERS_DB_PATH);

  let stopping = false;
  /** The real stop path -- see header doc, "Escalation wiring". markCleanShutdown()
   * FIRST (so the heartbeat file reflects a clean exit), THEN the real process.exit(). */
  const stop = (exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[run] stopping: markCleanShutdown() then process.exit(${exitCode})`);
    heartbeatWriter.markCleanShutdown();
    counterStore.close();
    deathEventStore.close();
    escalationsDbAdapter.close();
    process.exit(exitCode);
  };

  const detector = new SustainedDeclineDetector(consumer, {
    stop,
    ...(ESCALATION_THRESHOLD_COUNT !== undefined ? { thresholdCount: ESCALATION_THRESHOLD_COUNT } : {}),
    ...(ESCALATION_WINDOW_MS !== undefined ? { windowMs: ESCALATION_WINDOW_MS } : {}),
  });
  detector.on("escalated", (record: EscalationRecord) => {
    console.log(`[run] ESCALATED ${JSON.stringify(record)}`);
  });

  // --- Board-state watcher: the fourth interval-based loop, wiring real
  // "dispatch-eligible" board transitions into consumer.onEvent() -- see
  // header doc, "Board-state watcher". Additive to the synthetic workload
  // generator below, not a replacement of it.
  const watcher = new BoardStateWatcher({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    projectId: WATCHER_PROJECT_ID,
    token: cfg.token,
    ...(WATCHER_POLL_INTERVAL_MS !== undefined ? { pollIntervalMs: WATCHER_POLL_INTERVAL_MS } : {}),
  });
  wireDispatchEligible(watcher, consumer);
  watcher.on("poll-error", (error: unknown) => {
    console.error("[watcher] poll failed:", error);
  });
  const swarmDispatcher = new VerificationSwarmDispatcher({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    projectId: WATCHER_PROJECT_ID,
    token: cfg.token,
    verifierPool: AURIGA_VERIFIER_POOL,
  });
  swarmDispatcher.attach(watcher);
  swarmDispatcher.on("swarm-dispatched", (event: unknown) => {
    console.log(`[verification-swarm] DISPATCHED ${JSON.stringify(event)}`);
  });
  swarmDispatcher.on("swarm-skipped", (event: unknown) => {
    console.log(`[verification-swarm] SKIPPED ${JSON.stringify(event)}`);
  });
  swarmDispatcher.on("swarm-error", (event: unknown) => {
    console.error(`[verification-swarm] ERROR ${JSON.stringify(event)}`);
  });
  // Observability: mirrors InstrumentedLock's "wrap + observe + re-emit"
  // decorator shape (auriga/observability/instrumented-lock.ts), applied to
  // the watcher's own real "dispatch-eligible"/"review-eligible" events --
  // see observability-transition-verdict-counters.yaml. Purely additive:
  // does not change what watcher.start()/wireDispatchEligible() above do,
  // only observes the same events they already fire.
  const instrumentedWatcher = new InstrumentedWatcher(watcher);
  watcher.start();
  // watcher.start() begins BoardStateWatcher's own internal self-scheduling
  // setTimeout loop (see its class doc, "Poll loop shape") -- deliberately
  // NOT wrapped in a second setInterval here; this call IS the fourth
  // interval-based loop, running in-process alongside workload/sweep/
  // counters below.

  // --- Verdict synthesizer: the fifth interval-based loop, resolving
  // verification-swarm verdicts on review-status issues -- see
  // auriga/watcher/verdict-synthesis.ts's class doc, "Why this needs its
  // own poll loop (not 'the woken dispatch')". Reuses the SAME
  // trackerAdapter instance the consumer above already uses (no second
  // write path to Multica's status field) and an escalationsDbAdapter
  // pointed at the same db file SustainedDeclineDetector's own escalation
  // records already land in, so both escalation sources stay one queryable
  // source of truth.
  const escalationsDbAdapter = new SqliteDBAdapter(ESCALATIONS_DB_PATH);
  const verdictSynthesizer = new VerdictSynthesizer({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    projectId: WATCHER_PROJECT_ID,
    token: cfg.token,
    trackerAdapter,
    dbAdapter: escalationsDbAdapter,
    ...(WATCHER_POLL_INTERVAL_MS !== undefined ? { pollIntervalMs: WATCHER_POLL_INTERVAL_MS } : {}),
  });
  verdictSynthesizer.on("poll-error", (error: unknown) => {
    console.error("[verdict-synthesis] poll failed:", error);
  });
  verdictSynthesizer.on("verdict-approved", (event: unknown) => {
    console.log(`[verdict-synthesis] APPROVED ${JSON.stringify(event)}`);
  });
  verdictSynthesizer.on("verdict-escalated", (event: unknown) => {
    console.log(`[verdict-synthesis] ESCALATED ${JSON.stringify(event)}`);
  });
  // Observability: same InstrumentedLock-style "wrap + observe + re-emit"
  // decorator shape as instrumentedWatcher above, applied to the
  // synthesizer's own real "verdict-approved"/"verdict-escalated" events --
  // see observability-transition-verdict-counters.yaml. Purely additive:
  // does not change what verdictSynthesizer.start() below does, only
  // observes the same events it already fires.
  const instrumentedVerdictSynthesizer = new InstrumentedVerdictSynthesizer(verdictSynthesizer);
  verdictSynthesizer.start();
  // Same self-scheduling-setTimeout shape as the watcher above -- this
  // call IS the fifth interval-based loop.

  // --- Synthetic workload: see header doc for full rationale ---
  const preCreatedTaskIssueIds = new Set<string>();
  let workloadTick = 0;
  // TEST-ONLY: when AURIGA_MULTICA_SERVER_URL_OVERRIDE points at a
  // deliberately unreachable endpoint (escalation-wiring verification),
  // skip the real-issue pre-create -- it would only fail before ever
  // reaching consumer.onEvent(), which would defeat the point (nothing
  // would ever exercise AurigaConsumer's error boundary /
  // SustainedDeclineDetector at all). Use a synthetic taskId directly
  // instead, so onEvent() -> lock.claim() is what fails and gets
  // classified -- the real code path this verification exists to prove.
  const skipTrackerIssuePreCreate = Boolean(process.env.AURIGA_MULTICA_SERVER_URL_OVERRIDE);
  const workloadTimer = setInterval(() => {
    void (async () => {
      workloadTick += 1;
      try {
        let taskId: string;
        if (skipTrackerIssuePreCreate) {
          taskId = `escalation-verification:${workloadTick}:${randomUUID()}`;
        } else {
          const title = `auriga-soak: synthetic-task-${workloadTick}-${randomUUID()}`;
          taskId = await createSyntheticTrackerIssue(cfg, title);
          preCreatedTaskIssueIds.add(taskId);
        }
        const event: EventContract = {
          id: `auriga-run:synthetic:${taskId}`,
          type: "task.claimable",
          payload: { taskId },
          timestamp: new Date().toISOString(),
          source: "auriga-run-synthetic-workload",
        };
        await consumer.onEvent(event);
        console.log(`[workload] tick ${workloadTick}: created+dispatched taskId=${taskId}`);
      } catch (error) {
        console.error(`[workload] tick ${workloadTick} failed:`, error);
      }
    })();
  }, WORKLOAD_INTERVAL_MS);
  // Deliberately NOT unref()'d -- see header doc, "Why the process stays alive".

  // --- Sweep loop: reclaims completed synthetic tasks' leases promptly ---
  const sweepTimer = setInterval(() => {
    void (async () => {
      try {
        const reclaimed = await instrumentedLock.sweep();
        if (reclaimed.length > 0) {
          console.log(`[sweep] reclaimed ${reclaimed.length} task(s): ${JSON.stringify(reclaimed)}`);
        }
      } catch (error) {
        console.error("[sweep] failed:", error);
      }
    })();
  }, SWEEP_INTERVAL_MS);

  // --- Counters derivation + human-readable status line ---
  //
  // Re-derives over InstrumentedLock's FULL accumulated event history on
  // every tick, not just events new since the last tick. Chosen for
  // correctness over a marginal, unneeded optimization: deriveCounters()'s
  // "dropped" check depends on whether a claim from ANY point in the past
  // still has no matching release, so a windowed/incremental feed would
  // still have to carry forward every still-open claim across ticks
  // anyway -- at that point it's re-implementing deriveCounters()'s own
  // bookkeeping, not avoiding it. ObservabilityCounterStore's
  // `INSERT OR IGNORE` on `(task_id, lease_id)` makes re-deriving and
  // re-persisting the same already-recorded findings idempotent (see its
  // own class doc), so repeated full-history derivation costs nothing
  // beyond CPU -- and for a single-consumer soak test producing on the
  // order of thousands of events over 24-48h (one workload tick/minute),
  // that cost is trivially small.
  const countersTimer = setInterval(() => {
    try {
      const derived = deriveCounters(instrumentedLock.events);
      counterStore.record(derived);
      const dropped = counterStore.getDroppedTasks();
      const duplicated = counterStore.getDuplicatedTasks();

      // Transition/verdict counters -- same store instance, extended, not a
      // second store (observability-transition-verdict-counters.yaml). Like
      // the lock-event derivation above, this re-persists InstrumentedWatcher/
      // InstrumentedVerdictSynthesizer's FULL accumulated event history every
      // tick; recordTransitions()/recordVerdicts()'s own INSERT OR IGNORE
      // makes that idempotent (see ObservabilityCounterStore's class doc),
      // the same reasoning as the lock-event path just above.
      counterStore.recordTransitions(instrumentedWatcher.events);
      counterStore.recordVerdicts(instrumentedVerdictSynthesizer.events);
      const transitionVerdictCounts = deriveTransitionVerdictCounts([
        ...instrumentedWatcher.events,
        ...instrumentedVerdictSynthesizer.events,
      ]);

      console.log(
        `[status] uptime=${formatUptime(Date.now() - processStartedAt)} ` +
          `dropped=${dropped.length} duplicated=${duplicated.length} ` +
          `transitionsFired=${transitionVerdictCounts.transitionsFired} swarmsDispatched=${transitionVerdictCounts.swarmsDispatched} ` +
          `unanimousApprove=${transitionVerdictCounts.unanimousApproveCount} escalations=${transitionVerdictCounts.escalationCount} ` +
          `lastHeartbeatAt=${new Date().toISOString()} ` +
          `workloadTicks=${workloadTick} lockEvents=${instrumentedLock.events.length} ` +
          `preCreatedIssues=${preCreatedTaskIssueIds.size} lockShadowIssues=${realLock.createdIssueIds.length}`,
      );
    } catch (error) {
      console.error("[status] counters derivation failed:", error);
    }
  }, COUNTERS_INTERVAL_MS);

  // --- Human-initiated clean stop (see header doc) ---
  const handleSignal = (signal: string): void => {
    console.log(`[run] received ${signal} -- treating as a human-initiated CLEAN shutdown, not a death`);
    console.log(`[run] preCreatedTaskIssueIds=${JSON.stringify([...preCreatedTaskIssueIds])}`);
    console.log(`[run] lockShadowIssueIds=${JSON.stringify(realLock.createdIssueIds)}`);
    clearInterval(workloadTimer);
    clearInterval(sweepTimer);
    clearInterval(countersTimer);
    void Promise.all([watcher.stop(), verdictSynthesizer.stop()]).finally(() => stop(0));
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  console.log(
    `[run] auriga/run.ts started. pid=${process.pid} workspace=${cfg.workspace_id} ` +
      `staleMs=${LOCK_STALE_MS} workloadIntervalMs=${WORKLOAD_INTERVAL_MS} ` +
      `sweepIntervalMs=${SWEEP_INTERVAL_MS} countersIntervalMs=${COUNTERS_INTERVAL_MS} ` +
      `watcherProjectId=${WATCHER_PROJECT_ID} watcherPollIntervalMs=${WATCHER_POLL_INTERVAL_MS ?? "default(30000)"} ` +
      `escalationThreshold=${ESCALATION_THRESHOLD_COUNT ?? "default(5)"} ` +
      `escalationWindowMs=${ESCALATION_WINDOW_MS ?? "default(60000)"}`,
  );
}

main().catch((error) => {
  console.error("[run] fatal startup error:", error);
  process.exit(1);
});
