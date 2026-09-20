// auriga/observability-transition-verdict-composition.test.ts — proves this
// story's fourth acceptance criterion structurally: run.ts's composition
// root actually wraps the real watcher/verdictSynthesizer instances it
// already constructs in InstrumentedWatcher/InstrumentedVerdictSynthesizer,
// and persists their observed streams into the SAME counterStore instance
// dropped/duplicated already use -- not a second store.
//
// Same structural (source-text) approach as run-composition.test.ts and
// verdict-synthesis-composition.test.ts, for the same reason: spawning the
// real run.ts entrypoint would read/overwrite the SAME fixed, shared,
// gitignored runtime files (heartbeat.json, counters.db, escalations.db) a
// real operator's live soak-test run may depend on. See
// run-composition.test.ts's own header doc for the full rationale, which
// applies unchanged here.
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

test("run.ts imports InstrumentedWatcher, InstrumentedVerdictSynthesizer, and deriveTransitionVerdictCounts", () => {
  assert.match(
    source,
    /import\s*\{\s*InstrumentedWatcher\s*\}\s*from\s*["']\.\/observability\/instrumented-watcher\.ts["']/,
  );
  assert.match(
    source,
    /import\s*\{\s*InstrumentedVerdictSynthesizer\s*\}\s*from\s*["']\.\/observability\/instrumented-verdict-synthesizer\.ts["']/,
  );
  assert.match(
    source,
    /deriveTransitionVerdictCounts/,
    "expected the new pure derivation function to be imported/used in run.ts",
  );
});

test("main() wraps the real watcher and verdictSynthesizer instances in their instrumentation decorators", () => {
  const body = mainBody(source);

  assert.match(
    body,
    /new InstrumentedWatcher\(\s*watcher\s*\)/,
    "expected the real BoardStateWatcher instance to be wrapped in InstrumentedWatcher",
  );
  assert.match(
    body,
    /new InstrumentedVerdictSynthesizer\(\s*verdictSynthesizer\s*\)/,
    "expected the real VerdictSynthesizer instance to be wrapped in InstrumentedVerdictSynthesizer",
  );
});

test("the counters interval persists observed transitions/verdicts into the SAME counterStore instance dropped/duplicated already use", () => {
  const body = mainBody(source);
  const countersTimerIndex = body.indexOf("const countersTimer = setInterval(");
  assert.ok(countersTimerIndex >= 0, "expected to find the existing counters interval");
  const countersTimerBlock = body.slice(countersTimerIndex);

  assert.match(
    countersTimerBlock,
    /counterStore\.recordTransitions\(/,
    "expected observed transitions to be persisted through counterStore, not a second store",
  );
  assert.match(
    countersTimerBlock,
    /counterStore\.recordVerdicts\(/,
    "expected observed verdicts to be persisted through counterStore, not a second store",
  );
});

test("run.ts does not construct a second ObservabilityCounterStore instance", () => {
  const matches = source.match(/new ObservabilityCounterStore\(/g) ?? [];
  assert.equal(matches.length, 1, "expected exactly one ObservabilityCounterStore construction in run.ts");
});

test("run.ts never spawns a child process or subprocess for the new instrumentation -- it runs in this same process", () => {
  assert.doesNotMatch(source, /node:child_process/, "run.ts must not import node:child_process anywhere");
  assert.doesNotMatch(source, /\bspawn\(|\bfork\(|\bexecFile\(/, "run.ts must not spawn/fork/execFile a subprocess");
});
