// auriga/verdict-synthesis-composition.test.ts — proves VerdictSynthesizer is
// actually wired into run.ts's composition root as a fifth interval-based
// loop, not just built and tested in isolation (auriga/watcher/
// verdict-synthesis.test.ts already covers its resolution logic against a
// mocked Multica layer). Found missing during independent review of the
// verdict-synthesis-escalation story: the component existed but nothing in
// run.ts constructed or started it, so the assembled review -> swarm ->
// synthesis loop would never actually run in production.
//
// Same structural (source-text) approach as run-composition.test.ts, for the
// same reason: spawning the real run.ts entrypoint would read/overwrite the
// SAME fixed, shared, gitignored runtime files (heartbeat.json, counters.db,
// escalations.db) a real operator's live soak-test run may depend on. See
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

test("run.ts imports VerdictSynthesizer and a DBAdapter implementation for it", () => {
  assert.match(source, /import\s*\{\s*VerdictSynthesizer\s*\}\s*from\s*["']\.\/watcher\/verdict-synthesis\.ts["']/);
  assert.match(source, /import\s*\{\s*SqliteDBAdapter\s*\}\s*from\s*["']\.\/adapters\/db\/index\.ts["']/);
});

test("main() constructs a real VerdictSynthesizer, reusing the SAME trackerAdapter instance the consumer uses, and starts it", () => {
  const body = mainBody(source);

  assert.match(body, /new VerdictSynthesizer\(\{/, "expected a real VerdictSynthesizer to be constructed in main()");
  assert.match(
    body,
    /trackerAdapter,/,
    "expected the synthesizer's config to reuse the existing trackerAdapter instance, not construct a second one",
  );
  assert.match(
    body,
    /verdictSynthesizer\.start\(\)/,
    "expected the synthesizer to actually be started, not just constructed",
  );
});

test("the synthesizer's dbAdapter points at the SAME escalations db file SustainedDeclineDetector's own default resolves to", () => {
  // Both must resolve to auriga/escalation/escalations.db -- one queryable
  // source of truth for a human or Consus reading escalations, per
  // verdict-synthesis-escalation's own "reuse EscalationRecord, don't
  // fragment" design decision extended to storage location.
  assert.match(
    source,
    /new URL\(\s*["']\.\/escalation\/escalations\.db["']\s*,\s*import\.meta\.url\s*\)/,
    "expected run.ts's ESCALATIONS_DB_PATH to point at auriga/escalation/escalations.db, matching SustainedDeclineDetector's own internal default path",
  );
});

test("run.ts's clean-shutdown path drains the verdict synthesizer and closes its db adapter, same as the other interval loops", () => {
  const body = mainBody(source);
  assert.match(
    body,
    /verdictSynthesizer\.stop\(\)/,
    "expected a clean shutdown to stop the verdict synthesizer too, not just the watcher and the three setInterval timers",
  );
  assert.match(
    body,
    /escalationsDbAdapter\.close\(\)/,
    "expected the escalations db connection to be closed on clean shutdown, mirroring counterStore.close()/deathEventStore.close()",
  );
});
