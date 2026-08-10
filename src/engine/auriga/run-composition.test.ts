// auriga/run-composition.test.ts — proves this story's second acceptance
// criterion: "the watcher runs as a fourth interval-based loop alongside
// the existing consumer/sweep/observability intervals, in the same process
// -- not a separate process or subprocess."
//
// ## Why this is a structural (source-text) test, not a spawned-process one
//
// Every OTHER e2e test in this repo that proves a process-level claim
// (auriga/escalation/e2e-stop.test.ts, auriga/consumer/restart-safety.test.ts)
// spawns a REAL, DEDICATED runner script written specifically to be spawned
// (e2e-runner.ts / restart-safety-runner.ts) — never the shared, stateful
// auriga/run.ts entrypoint itself. That's deliberate, and this test follows
// the same discipline rather than being the first to break it:
// auriga/run.ts's HeartbeatWriter/DeathEventStore/ObservabilityCounterStore
// all resolve to FIXED sibling-file paths (auriga/observability/
// heartbeat.json, counters.db, death-events.db — see death-detection.ts's
// DEFAULT_HEARTBEAT_PATH / DEFAULT_DEATH_EVENTS_DB_PATH, and run.ts's own
// COUNTERS_DB_PATH), with no constructor/env override for any of them,
// unlike e2e-runner.ts's injectable `dbPath`. Spawning the real run.ts here
// would read and overwrite that SAME shared, gitignored runtime state a
// real human's actual soak-test run depends on (see auriga/run.ts's own
// header doc, "why staleMs -- 60s") — a risk none of this story's
// acceptance criteria asks this test to take on, and adding override
// plumbing for those three paths is out of this story's scope (files_to_
// modify names only run.ts's watcher-wiring addition).
//
// What IS spawned-process-tested already: BoardStateWatcher's own polling
// behavior (auriga/watcher/index.test.ts) and the watcher -> consumer
// translation this story adds (auriga/watcher/dispatch-wiring.test.ts,
// using the REAL BoardStateWatcher + REAL AurigaConsumer classes, wired via
// the SAME `wireDispatchEligible` function run.ts itself calls below). What
// remains to prove here is narrower and genuinely structural: that run.ts's
// composition root actually calls that function, on a really-constructed
// watcher, inside the SAME `main()` as the pre-existing three intervals,
// with no subprocess/child_process involved anywhere in the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUN_TS_PATH = fileURLToPath(new URL("./run.ts", import.meta.url));
const source = readFileSync(RUN_TS_PATH, "utf8");

function mainBody(src: string): string {
  const start = src.indexOf("async function main(): Promise<void> {");
  assert.ok(start >= 0, "expected to find run.ts's main() function");
  const end = src.indexOf("\nmain().catch(", start);
  assert.ok(end > start, "expected to find main()'s trailing main().catch(...) call after its body");
  return src.slice(start, end);
}

test("run.ts imports BoardStateWatcher and the dispatch-wiring translation function", () => {
  assert.match(source, /import\s*\{\s*BoardStateWatcher\s*\}\s*from\s*["']\.\/watcher\/index\.ts["']/);
  assert.match(
    source,
    /import\s*\{\s*wireDispatchEligible\s*\}\s*from\s*["']\.\/watcher\/dispatch-wiring\.ts["']/,
  );
});

test("run.ts imports and wires VerificationSwarmDispatcher with the configured Auriga verifier pool", () => {
  assert.match(
    source,
    /import\s*\{\s*VerificationSwarmDispatcher\s*\}\s*from\s*["']\.\/watcher\/verification-swarm\.ts["']/,
  );
  assert.match(source, /import\s*\{\s*AURIGA_VERIFIER_POOL\s*\}\s*from\s*["']\.\/watcher\/verifier-pool\.ts["']/);

  const body = mainBody(source);
  assert.match(body, /new VerificationSwarmDispatcher\(\{/, "expected the real swarm dispatcher in main()");
  assert.match(body, /verifierPool:\s*AURIGA_VERIFIER_POOL/, "expected production wiring to use the shared verifier pool");
  assert.match(body, /swarmDispatcher\.attach\(\s*watcher\s*\)/, "expected review-eligible events to feed swarm dispatch");
});

test("main() constructs a real BoardStateWatcher and wires it via wireDispatchEligible(), inside the same composition root as the pre-existing three intervals", () => {
  const body = mainBody(source);

  assert.match(body, /new BoardStateWatcher\(\{/, "expected a real BoardStateWatcher to be constructed in main()");
  assert.match(
    body,
    /wireDispatchEligible\(\s*watcher\s*,\s*consumer\s*\)/,
    "expected the watcher's dispatch-eligible events to be wired to the SAME consumer instance the synthetic workload generator uses",
  );
  assert.match(body, /watcher\.start\(\)/, "expected the watcher to actually be started, not just constructed");

  // The pre-existing three intervals must still be present, unchanged in
  // kind (additive, not replaced) -- see this story's design_decisions.
  assert.match(body, /const workloadTimer = setInterval\(/, "synthetic workload generator must remain (additive, not removed)");
  assert.match(body, /const sweepTimer = setInterval\(/, "sweep loop must remain");
  assert.match(body, /const countersTimer = setInterval\(/, "counters/observability loop must remain");
});

test("watcher.start() is positioned before the synthetic workload section, and both feed the same onEvent() path additively", () => {
  const body = mainBody(source);
  const watcherStartIndex = body.indexOf("watcher.start()");
  const syntheticSectionIndex = body.indexOf("Synthetic workload");
  const workloadOnEventIndex = body.indexOf("await consumer.onEvent(event)");

  assert.ok(watcherStartIndex >= 0);
  assert.ok(syntheticSectionIndex >= 0);
  assert.ok(workloadOnEventIndex >= 0);
  assert.ok(
    watcherStartIndex < syntheticSectionIndex,
    "watcher composition should be wired before the synthetic generator section, not interleaved into/after it",
  );
  assert.ok(
    workloadOnEventIndex > syntheticSectionIndex,
    "the synthetic workload generator must still call consumer.onEvent() itself -- unmodified, additive second source",
  );
});

test("run.ts never spawns a child process or subprocess for the watcher -- it runs in this same process", () => {
  assert.doesNotMatch(source, /node:child_process/, "run.ts must not import node:child_process anywhere");
  assert.doesNotMatch(source, /\bspawn\(|\bfork\(|\bexecFile\(/, "run.ts must not spawn/fork/execFile a subprocess");
});

test("the watcher's SIGINT/SIGTERM shutdown is wired into the same clean-stop path as the rest of the process", () => {
  const body = mainBody(source);
  assert.match(
    body,
    /watcher\.stop\(\)/,
    "expected a clean shutdown to stop the watcher too, not just the three setInterval timers",
  );
});
