// auriga/watcher/index.test.ts — tests BoardStateWatcher against a mocked
// Multica HTTP layer (node:test's built-in `t.mock.method` on
// `globalThis.fetch`), per this story's explicit "mocked, not live" test
// requirement (live-Multica verification is p2-acceptance-live-verification's
// job, not this one). Uses real, short (10-20ms) poll intervals and real
// wall-clock `delay()`s rather than fake timers, mirroring
// auriga/observability/death-detection.test.ts's existing precedent for
// testing an interval-driven component.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardStateWatcher, type BoardStateWatcherConfig } from "./index.ts";

interface FakeIssue {
  id: string;
  status: string;
  project_id?: string;
}

function issuesResponse(issues: FakeIssue[]): Response {
  return new Response(JSON.stringify({ issues }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function baseConfig(overrides: Partial<BoardStateWatcherConfig> = {}): BoardStateWatcherConfig {
  return {
    serverUrl: "http://fake-multica.test",
    workspaceId: "ws-1",
    projectId: "project-1",
    token: "fake-token",
    pollIntervalMs: 20,
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("dispatch-eligible fires exactly once for an issue that stays todo across multiple poll ticks", async (t) => {
  t.mock.method(globalThis, "fetch", async () => issuesResponse([{ id: "issue-1", status: "todo", project_id: "project-1" }]));

  const watcher = new BoardStateWatcher(baseConfig());
  const events: unknown[] = [];
  watcher.on("dispatch-eligible", (e) => events.push(e));

  watcher.start();
  await delay(90); // several 20ms ticks
  await watcher.stop();

  assert.equal(events.length, 1, "should fire exactly once, not once per poll tick while status is unchanged");
  assert.deepEqual(events[0], { issueId: "issue-1", previousStatus: undefined });
});

test("review-eligible fires exactly once when an issue transitions from in_progress to in_review, carrying the previous status", async (t) => {
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    call++;
    const status = call === 1 ? "in_progress" : "in_review";
    return issuesResponse([{ id: "issue-2", status, project_id: "project-1" }]);
  });

  const watcher = new BoardStateWatcher(baseConfig());
  const dispatchEvents: unknown[] = [];
  const reviewEvents: unknown[] = [];
  watcher.on("dispatch-eligible", (e) => dispatchEvents.push(e));
  watcher.on("review-eligible", (e) => reviewEvents.push(e));

  watcher.start();
  await delay(90);
  await watcher.stop();

  assert.equal(dispatchEvents.length, 0, "in_progress is not a dispatch-eligible status");
  assert.equal(reviewEvents.length, 1, "should fire exactly once for the one in_progress -> in_review transition");
  assert.deepEqual(reviewEvents[0], { issueId: "issue-2", previousStatus: "in_progress" });
});

test("an issue that stays in_review across multiple ticks only fires review-eligible once", async (t) => {
  t.mock.method(globalThis, "fetch", async () => issuesResponse([{ id: "issue-4", status: "in_review", project_id: "project-1" }]));

  const watcher = new BoardStateWatcher(baseConfig());
  const events: unknown[] = [];
  watcher.on("review-eligible", (e) => events.push(e));

  watcher.start();
  await delay(90);
  await watcher.stop();

  assert.equal(events.length, 1);
});

test("poll interval is configurable via the constructor, overriding the 30s default", async (t) => {
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount++;
    return issuesResponse([]);
  });

  const watcher = new BoardStateWatcher(baseConfig({ pollIntervalMs: 15 }));
  watcher.start();
  await delay(70); // several 15ms ticks -- would see 0 polls in this window at the 30s default
  await watcher.stop();

  assert.ok(callCount >= 3, `expected several polls at the configured 15ms interval, got ${callCount} fetch call(s)`);
});

test("default poll interval is used when none is configured", async (t) => {
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount++;
    return issuesResponse([]);
  });

  const { pollIntervalMs, ...withoutInterval } = baseConfig();
  const watcher = new BoardStateWatcher(withoutInterval);
  watcher.start();
  await delay(50);
  await watcher.stop();

  assert.equal(callCount, 0, "no poll should have fired yet at the 30s default within a 50ms window");
});

test("stop() lets an in-flight poll finish without emitting further events, and schedules no new poll", async (t) => {
  let resolveFetch: (() => void) | undefined;
  let fetchCallCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCallCount++;
    await new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    return issuesResponse([{ id: "issue-3", status: "todo", project_id: "project-1" }]);
  });

  const watcher = new BoardStateWatcher(baseConfig({ pollIntervalMs: 10 }));
  const events: unknown[] = [];
  watcher.on("dispatch-eligible", (e) => events.push(e));

  watcher.start();
  await delay(20); // let the first tick fire and get stuck awaiting the fetch mock

  const stopPromise = watcher.stop();
  assert.equal(fetchCallCount, 1, "the in-flight poll's fetch should already have been called before stop()");

  resolveFetch?.();
  await stopPromise;

  assert.equal(events.length, 0, "the in-flight poll must not emit events once stop() has been called");

  const countAfterStop = fetchCallCount;
  await delay(50); // long enough for several more ticks if (incorrectly) still scheduled
  assert.equal(fetchCallCount, countAfterStop, "no new poll tick should be scheduled after stop()");
});

test("#listIssues() requests scoped to the configured project via a project_id query param", async (t) => {
  let requestedUrl: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requestedUrl = url;
    return issuesResponse([]);
  });

  const watcher = new BoardStateWatcher(baseConfig({ projectId: "project-abc" }));
  watcher.start();
  await delay(30);
  await watcher.stop();

  assert.ok(requestedUrl, "fetch should have been called at least once");
  const params = new URL(requestedUrl!).searchParams;
  assert.equal(params.get("project_id"), "project-abc", "the request must scope to this watcher's configured project");
});

test("board-state-machine gap fixed after review: a transition on a DIFFERENT project's issue never emits an event, even if it somehow appears in the response", async (t) => {
  // Defense in depth: even if server-side project_id filtering were ever
  // bypassed or buggy, this watcher must not react to another project's
  // issues -- this was the real gap PAN-3951 was sent back for (it
  // originally queried the whole workspace with no project filter at all,
  // which would have misfired against every other project in the
  // workspace, including this epic's own Multica tracking issues).
  t.mock.method(globalThis, "fetch", async () =>
    issuesResponse([
      { id: "other-project-issue", status: "todo", project_id: "some-other-project" },
      { id: "this-project-issue", status: "todo", project_id: "project-1" },
    ]),
  );

  const watcher = new BoardStateWatcher(baseConfig({ projectId: "project-1" }));
  const events: unknown[] = [];
  watcher.on("dispatch-eligible", (e) => events.push(e));

  watcher.start();
  await delay(30);
  await watcher.stop();

  assert.equal(events.length, 1, "exactly one event, for the matching-project issue only");
  assert.deepEqual(events[0], { issueId: "this-project-issue", previousStatus: undefined });
});

test("start() is idempotent -- calling it again while already running does not schedule a second timer loop", async (t) => {
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount++;
    return issuesResponse([]);
  });

  const watcher = new BoardStateWatcher(baseConfig({ pollIntervalMs: 20 }));
  watcher.start();
  watcher.start();
  watcher.start();
  await delay(90);
  await watcher.stop();

  // ~4 ticks expected in a 90ms window at 20ms intervals from ONE loop;
  // if start() had spawned extra concurrent loops this would be far higher.
  assert.ok(callCount <= 5, `expected roughly one loop's worth of polls, got ${callCount}`);
});
