// Standalone runner spawned as a REAL child process by e2e-stop.test.ts
// (never imported/run directly by node:test itself -- it is deliberately
// not a *.test.ts file, same convention as
// auriga/consumer/restart-safety-runner.ts). Proves the REAL chain --
// AurigaConsumer wired to a REAL MulticaLock + MulticaTrackerAdapter,
// feeding a REAL SustainedDeclineDetector -- actually escalates-and-stops
// under sustained REAL dispatch failure, not a synthetic/injected one.
//
// Unlike restart-safety-runner.ts, this script does NOT talk to a live
// Multica instance. The whole point of this test is a controlled, induced
// failure: MulticaLock/MulticaTrackerAdapter are pointed at
// `http://127.0.0.1:1` -- localhost, port 1, a port nothing listens on and
// that requires no privilege to attempt to connect to. A `fetch()` against
// it fails IMMEDIATELY with a real, OS-level ECONNREFUSED (there is no DNS
// lookup, no TLS handshake, no server-side timeout to wait out -- the
// kernel refuses the TCP SYN as soon as it arrives), which is what makes
// this both a REAL network failure (not a mock) and a FAST, deterministic
// one (not a slow timeout against some other kind of misconfiguration,
// which would make this test flaky/slow). This is deliberately not a real
// or live Multica endpoint -- see this story's description.
//
// Flow:
//   1. Construct a real MulticaLock + MulticaTrackerAdapter against the
//      unreachable endpoint above, and a real AurigaConsumer wired to both
//      (auriga/consumer/index.ts).
//   2. Construct a real SustainedDeclineDetector (auriga/escalation/index.ts)
//      subscribed to that consumer's real "failure" event, with NO injected
//      `stop` -- this is the one deliberate divergence from this repo's
//      usual test-double-injection pattern (see index.ts's
//      SustainedDeclineDetectorOptions.stop doc): proving the REAL
//      `process.exit(ESCALATION_EXIT_CODE)` call actually terminates this
//      process is exactly what this test exists to verify, so a spy here
//      would defeat the point. `dbAdapter` IS still injected (a real
//      SqliteDBAdapter, but pointed at a path the parent test controls via
//      argv[2], not this module's on-disk default) -- purely so the parent
//      test can read the written record back after this process exits,
//      not to fake anything about the write itself.
//   3. Drive the consumer with a tight loop of synthetic EventContracts
//      (distinct taskId each time, so MulticaLock's auto-provisioning
//      "unknown taskId -> create issue" path attempts a NEW POST every
//      iteration instead of reusing a cached issueId -- see
//      MulticaLock's class doc's "taskId -> Multica issue mapping"
//      section) via consumer.onEvent(), sequentially, until either:
//      - the process is killed by the detector's own real process.exit()
//        call (the expected, successful path), or
//      - a safety-net iteration cap is hit, in which case this script
//        exits with NEVER_ESCALATED_EXIT_CODE -- a code that is neither
//        ESCALATION_EXIT_CODE (3) nor 0, so the parent test can tell
//        "the chain never escalated" (a real regression) apart from
//        "escalated correctly" instead of just hanging or timing out
//        with no useful signal.
//
// Signal protocol (read by the parent test via this process's stdout):
//   FAILURE <json>        -- printed whenever AurigaConsumer emits a
//                             "failure" event (expected: every iteration,
//                             since every dispatch attempt fails against
//                             the unreachable endpoint). Non-fatal, logged
//                             for visibility/debugging only.
//   ESCALATION_KEY <key>  -- printed the instant the detector's injected
//                             dbAdapter.write() resolves (i.e. the
//                             EscalationRecord has actually landed on
//                             disk), BEFORE the detector calls the real
//                             process.exit(). This is the ONLY way the
//                             parent test can know which key to read back
//                             after this process is gone: the detector's
//                             own "escalated" event (which carries the
//                             record) fires AFTER process.exit() is
//                             called, by which point this process no
//                             longer runs any further JS -- so that event
//                             is unobservable from outside. Printed by
//                             SignalingDBAdapter below, a thin decorator
//                             around the real SqliteDBAdapter, following
//                             this repo's established
//                             SignalingLock-in-restart-safety-runner.ts
//                             pattern for "observe a real call's
//                             completion via a stdout marker, without
//                             teaching the class under test anything about
//                             this test harness".
import { randomUUID } from "node:crypto";
import { MulticaLock } from "../lock/index.ts";
import { MulticaTrackerAdapter } from "../adapters/multica/index.ts";
import { AurigaConsumer, type ClassifiedFailure } from "./../consumer/index.ts";
import { SustainedDeclineDetector } from "./index.ts";
import { SqliteDBAdapter } from "../adapters/db/index.ts";
import type { DBAdapter } from "../../contracts/db-adapter.ts";
import type { EventContract } from "../../contracts/event.ts";

/**
 * Deliberately unreachable: localhost, port 1. Nothing listens here (port
 * 1 is a low, reserved port no unprivileged service binds to), so
 * `fetch()` against it fails fast with a real, OS-level connection-refused
 * error rather than a slow timeout -- see this file's header doc for the
 * full rationale.
 */
const UNREACHABLE_URL = "http://127.0.0.1:1";

/**
 * Small on purpose: this test's job is to prove the chain escalates at
 * all, not to exercise a specific production threshold (that number, and
 * its own rationale, lives in auriga/escalation/index.ts's
 * DEFAULT_THRESHOLD_COUNT doc and is intentionally NOT reused here). 3 is
 * the smallest number that still meaningfully demonstrates "a COUNT of
 * failures, not just one," while keeping this test's real wall-clock
 * runtime tiny (3 sequential ECONNREFUSED failures against a port nothing
 * listens on, each sub-10ms in practice).
 */
const THRESHOLD_COUNT = 3;

/**
 * Generous relative to how fast 3 failures against an instantly-refusing
 * connection actually land (well under a second in practice -- see above):
 * 10 seconds. This is not tuned to be tight; it only needs to be large
 * enough that real (fast) failures never fall outside the window purely
 * because of scheduling jitter, since a too-tight window here would make
 * this test flaky for reasons that have nothing to do with the behavior
 * under test.
 */
const WINDOW_MS = 10_000;

/**
 * Safety-net cap on how many onEvent() iterations this script will run
 * before giving up. 10x THRESHOLD_COUNT: generous enough that ordinary
 * scheduling variance can never trip it if the chain is actually working,
 * tight enough that a genuinely broken chain (e.g. failures not
 * propagating, or not classifying/counting the way expected) fails this
 * script fast and visibly -- via NEVER_ESCALATED_EXIT_CODE -- instead of
 * hanging the test suite forever.
 */
const SAFETY_CAP_ITERATIONS = THRESHOLD_COUNT * 10;

/**
 * Exit code used when the safety cap above is hit without the detector
 * ever escalating. Deliberately neither 0 (success) nor
 * ESCALATION_EXIT_CODE (3, the real "escalated correctly" signal) -- see
 * this file's header doc's "Flow" section, point 3.
 */
const NEVER_ESCALATED_EXIT_CODE = 9;

/**
 * Builds a syntactically-valid (but entirely fake, unsigned) JWT carrying
 * only a `sub` claim -- the one claim MulticaLock/MulticaTrackerAdapter's
 * constructors actually decode (see their `decodeJwtSubject`/
 * `decodeJwtSubClaim` helpers). Neither class verifies the signature (both
 * document why -- Multica itself is the only real verifier, and there is
 * no live Multica here to verify against), so a real token is unnecessary:
 * this test never reaches a point where Multica would validate it, because
 * every request fails at the transport level (ECONNREFUSED) before any
 * server -- real or otherwise -- ever sees it.
 */
function fakeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.e2e-stop-signal-fake-signature`;
}

/**
 * Thin signaling decorator around a real DBAdapter -- delegates every call
 * straight through unchanged, and additionally prints the "ESCALATION_KEY"
 * marker line documented in this file's header doc the instant `write()`
 * resolves. See the header doc for why this lives here (test-harness
 * plumbing specific to this runner) rather than inside
 * SustainedDeclineDetector itself -- same reasoning as
 * restart-safety-runner.ts's SignalingLock.
 */
class SignalingDBAdapter implements DBAdapter {
  constructor(private readonly real: DBAdapter) {}

  async read<T>(key: string): Promise<T | null> {
    return this.real.read<T>(key);
  }

  async write<T>(key: string, value: T): Promise<void> {
    await this.real.write(key, value);
    console.log(`ESCALATION_KEY ${key}`);
  }
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("usage: e2e-runner.ts <dbPath>");
    process.exit(2);
  }

  const token = fakeJwt("e2e-stop-signal-subject");

  const lock = new MulticaLock({
    serverUrl: UNREACHABLE_URL,
    workspaceId: "e2e-stop-signal-workspace",
    token,
  });
  const trackerAdapter = new MulticaTrackerAdapter({
    server_url: UNREACHABLE_URL,
    workspace_id: "e2e-stop-signal-workspace",
    token,
  });
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  consumer.on("failure", (failure: ClassifiedFailure) => {
    console.log(
      `FAILURE ${JSON.stringify({ errorType: failure.errorType, sourceAdapter: failure.sourceAdapter, taskId: failure.taskId })}`,
    );
  });

  const dbAdapter = new SignalingDBAdapter(new SqliteDBAdapter(dbPath));

  // Constructed for its side effect (subscribing to consumer's "failure"
  // event) -- not otherwise referenced. No `stop` injected: see this
  // file's header doc, "Flow" step 2, for why proving the REAL
  // process.exit() call is exactly what this script must NOT fake.
  new SustainedDeclineDetector(consumer, {
    thresholdCount: THRESHOLD_COUNT,
    windowMs: WINDOW_MS,
    dbAdapter,
  });

  for (let i = 0; i < SAFETY_CAP_ITERATIONS; i++) {
    const taskId = `e2e-stop-signal:task:${i}:${randomUUID()}`;
    const event: EventContract = {
      id: `e2e-stop-signal-runner:${taskId}`,
      type: "task.claimable",
      payload: { taskId },
      timestamp: new Date().toISOString(),
      source: "e2e-stop-signal-runner",
    };
    await consumer.onEvent(event);
  }

  // Reached only if escalation never fired -- see NEVER_ESCALATED_EXIT_CODE's doc.
  console.error(
    `e2e-runner: safety cap of ${SAFETY_CAP_ITERATIONS} iterations hit without the detector escalating -- the chain did not escalate`,
  );
  process.exit(NEVER_ESCALATED_EXIT_CODE);
}

main().catch((error) => {
  console.error("e2e-runner: unexpected top-level failure:", error);
  process.exit(1);
});
