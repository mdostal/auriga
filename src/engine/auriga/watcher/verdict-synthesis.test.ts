// auriga/watcher/verdict-synthesis.test.ts — tests VerdictSynthesizer
// against a mocked Multica HTTP layer (node:test's `t.mock.method` on
// `globalThis.fetch`, mirroring auriga/watcher/index.test.ts and
// verification-swarm.test.ts's existing pattern for this watcher family)
// plus an injected in-memory test-double TrackerAdapter and DBAdapter --
// this component never talks to a real tracker/db in tests, per this
// story's explicit "mocked, not live" requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrackerAdapter, TaskStatus } from "../../contracts/tracker-adapter.ts";
import type { DBAdapter } from "../../contracts/db-adapter.ts";
import type { VerdictDisagreementEscalationRecord } from "../escalation/index.ts";
import { VerdictSynthesizer, type VerdictSynthesizerConfig } from "./verdict-synthesis.ts";

interface FakeIssue {
  id: string;
  status: string;
  project_id?: string;
}

interface RecordedRequest {
  method: string;
  url: string;
}

/** Wires a fetch mock answering the two endpoints this component polls:
 * GET /api/issues (the review-status parent list) and GET
 * /api/issues/{parentId}/children (per-parent verdict read). `reviewIssues`
 * is returned on every list call (a fixed snapshot per test, since these
 * tests care about repeated-tick idempotency, not simulating Multica's own
 * status transitions). `childrenByParent` maps parent id -> its stage-1
 * sub-issues. */
function mockFetch(
  t: { mock: { method: (...args: any[]) => unknown } },
  opts: { reviewIssues: FakeIssue[]; childrenByParent: Record<string, FakeIssue[]> },
): { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, url });

    if (url.includes("/children")) {
      const parentId = new URL(url).pathname.split("/").at(-2);
      const issues = opts.childrenByParent[parentId ?? ""] ?? [];
      return new Response(JSON.stringify({ issues }), { status: 200 });
    }

    if (url.includes("/api/issues")) {
      return new Response(JSON.stringify({ issues: opts.reviewIssues }), { status: 200 });
    }

    throw new Error(`mockFetch: unexpected request ${method} ${url}`);
  });
  return { requests };
}

function baseConfig(overrides: Partial<VerdictSynthesizerConfig> = {}): VerdictSynthesizerConfig {
  const { trackerAdapter, dbAdapter } = overrides;
  return {
    serverUrl: "http://fake-multica.test",
    workspaceId: "ws-1",
    projectId: "project-1",
    token: "fake-token",
    pollIntervalMs: 15,
    trackerAdapter: trackerAdapter ?? makeFakeTrackerAdapter().adapter,
    dbAdapter: dbAdapter ?? makeFakeDbAdapter().adapter,
    ...overrides,
  };
}

function makeFakeTrackerAdapter(): {
  adapter: TrackerAdapter;
  updateStatusCalls: Array<{ taskId: string; status: TaskStatus }>;
} {
  const updateStatusCalls: Array<{ taskId: string; status: TaskStatus }> = [];
  const adapter: TrackerAdapter = {
    async claimTask() {
      throw new Error("fake TrackerAdapter: claimTask not implemented -- unused by VerdictSynthesizer");
    },
    async updateStatus(taskId, status) {
      updateStatusCalls.push({ taskId, status });
    },
    async getTask() {
      throw new Error("fake TrackerAdapter: getTask not implemented -- unused by VerdictSynthesizer");
    },
  };
  return { adapter, updateStatusCalls };
}

function makeFakeDbAdapter(): { adapter: DBAdapter; writes: Array<{ key: string; value: unknown }> } {
  const writes: Array<{ key: string; value: unknown }> = [];
  const store = new Map<string, unknown>();
  const adapter: DBAdapter = {
    async read<T>(key: string): Promise<T | null> {
      return (store.get(key) as T | undefined) ?? null;
    },
    async write<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
      writes.push({ key, value });
    },
  };
  return { adapter, writes };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("unanimous approve (all children done) marks the parent done via TrackerAdapter.updateStatus", async (t) => {
  const { adapter: trackerAdapter, updateStatusCalls } = makeFakeTrackerAdapter();
  const { adapter: dbAdapter, writes } = makeFakeDbAdapter();
  mockFetch(t, {
    reviewIssues: [{ id: "parent-1", status: "in_review", project_id: "project-1" }],
    childrenByParent: {
      "parent-1": [
        { id: "sub-1", status: "done" },
        { id: "sub-2", status: "done" },
      ],
    },
  });

  const synthesizer = new VerdictSynthesizer(baseConfig({ trackerAdapter, dbAdapter }));
  synthesizer.start();
  await delay(30);
  await synthesizer.stop();

  assert.equal(updateStatusCalls.length, 1, "should update the parent's status exactly once");
  assert.deepEqual(updateStatusCalls[0], { taskId: "parent-1", status: "done" });
  assert.equal(writes.length, 0, "unanimous approve must not write any EscalationRecord");
});

test("any reject (at least one child blocked) escalates via EscalationRecord and leaves the parent status unchanged", async (t) => {
  const { adapter: trackerAdapter, updateStatusCalls } = makeFakeTrackerAdapter();
  const { adapter: dbAdapter, writes } = makeFakeDbAdapter();
  mockFetch(t, {
    reviewIssues: [{ id: "parent-2", status: "in_review", project_id: "project-1" }],
    childrenByParent: {
      "parent-2": [
        { id: "sub-1", status: "done" },
        { id: "sub-2", status: "blocked" },
      ],
    },
  });

  const synthesizer = new VerdictSynthesizer(baseConfig({ trackerAdapter, dbAdapter }));
  synthesizer.start();
  await delay(30);
  await synthesizer.stop();

  assert.equal(updateStatusCalls.length, 0, "disagreement must never write the parent's status -- not done, not blocked");
  assert.equal(writes.length, 1, "should write exactly one EscalationRecord");

  const record = writes[0]!.value as VerdictDisagreementEscalationRecord;
  assert.equal(record.reason, "verdict_disagreement");
  assert.equal(record.parentIssueId, "parent-2");
  assert.equal(typeof record.triggeredAt, "string");
  assert.equal(Number.isNaN(Date.parse(record.triggeredAt)), false);
  assert.deepEqual(
    new Set(record.verdicts.map((v) => `${v.issueId}:${v.status}`)),
    new Set(["sub-1:done", "sub-2:blocked"]),
  );
});

test("not all children terminal yet: synthesis does not run at all -- no status write, no escalation", async (t) => {
  const { adapter: trackerAdapter, updateStatusCalls } = makeFakeTrackerAdapter();
  const { adapter: dbAdapter, writes } = makeFakeDbAdapter();
  mockFetch(t, {
    reviewIssues: [{ id: "parent-3", status: "in_review", project_id: "project-1" }],
    childrenByParent: {
      "parent-3": [
        { id: "sub-1", status: "done" },
        { id: "sub-2", status: "in_progress" },
      ],
    },
  });

  const synthesizer = new VerdictSynthesizer(baseConfig({ trackerAdapter, dbAdapter }));
  synthesizer.start();
  await delay(50); // several ticks -- still must not synthesize prematurely
  await synthesizer.stop();

  assert.equal(updateStatusCalls.length, 0);
  assert.equal(writes.length, 0);
});

test("a parent with no children yet (swarm not dispatched) is never synthesized -- does not vacuously count as unanimous approve", async (t) => {
  const { adapter: trackerAdapter, updateStatusCalls } = makeFakeTrackerAdapter();
  const { adapter: dbAdapter, writes } = makeFakeDbAdapter();
  mockFetch(t, {
    reviewIssues: [{ id: "parent-4", status: "in_review", project_id: "project-1" }],
    childrenByParent: {},
  });

  const synthesizer = new VerdictSynthesizer(baseConfig({ trackerAdapter, dbAdapter }));
  synthesizer.start();
  await delay(40);
  await synthesizer.stop();

  assert.equal(updateStatusCalls.length, 0, "an empty children array must never be treated as vacuous unanimous approve");
  assert.equal(writes.length, 0);
});

test("idempotency: an already-synthesized (escalated) parent seen again on a later poll tick does not write a second EscalationRecord", async (t) => {
  const { adapter: trackerAdapter, updateStatusCalls } = makeFakeTrackerAdapter();
  const { adapter: dbAdapter, writes } = makeFakeDbAdapter();
  // Escalated parents stay at status "review" forever (per design -- see
  // verdict-synthesis.ts class doc), so a real, unmodified Multica would
  // keep returning this exact same review-status parent with the exact
  // same terminal children on every subsequent poll. This is precisely the
  // scenario the exactly-once tracking exists for.
  mockFetch(t, {
    reviewIssues: [{ id: "parent-5", status: "in_review", project_id: "project-1" }],
    childrenByParent: {
      "parent-5": [
        { id: "sub-1", status: "blocked" },
        { id: "sub-2", status: "blocked" },
      ],
    },
  });

  const synthesizer = new VerdictSynthesizer(baseConfig({ trackerAdapter, dbAdapter }));
  synthesizer.start();
  await delay(80); // several poll ticks over the same still-in_review parent
  await synthesizer.stop();

  assert.equal(updateStatusCalls.length, 0);
  assert.equal(writes.length, 1, "must write exactly one EscalationRecord despite the parent reappearing on every subsequent tick");
});

test("idempotency: an already-synthesized (approved) parent's status is not re-updated across multiple ticks", async (t) => {
  const { adapter: trackerAdapter, updateStatusCalls } = makeFakeTrackerAdapter();
  const { adapter: dbAdapter, writes } = makeFakeDbAdapter();
  // Simulates a slow/stale Multica list endpoint that keeps reporting this
  // parent as in_review even after this instance already marked it done --
  // the in-memory exactly-once tracking (not just "it fell out of the
  // review list") is what must prevent a second updateStatus call here.
  mockFetch(t, {
    reviewIssues: [{ id: "parent-6", status: "in_review", project_id: "project-1" }],
    childrenByParent: {
      "parent-6": [
        { id: "sub-1", status: "done" },
        { id: "sub-2", status: "done" },
      ],
    },
  });

  const synthesizer = new VerdictSynthesizer(baseConfig({ trackerAdapter, dbAdapter }));
  synthesizer.start();
  await delay(80);
  await synthesizer.stop();

  assert.equal(updateStatusCalls.length, 1, "must call updateStatus exactly once despite the parent reappearing on every subsequent tick");
  assert.equal(writes.length, 0);
});

test("project scoping: a different project's review-status issue is never synthesized, even if it somehow appears in the response", async (t) => {
  const { adapter: trackerAdapter, updateStatusCalls } = makeFakeTrackerAdapter();
  const { adapter: dbAdapter, writes } = makeFakeDbAdapter();
  mockFetch(t, {
    reviewIssues: [
      { id: "other-project-parent", status: "in_review", project_id: "some-other-project" },
      { id: "this-project-parent", status: "in_review", project_id: "project-1" },
    ],
    childrenByParent: {
      "other-project-parent": [{ id: "sub-x", status: "done" }],
      "this-project-parent": [{ id: "sub-1", status: "done" }],
    },
  });

  const synthesizer = new VerdictSynthesizer(baseConfig({ trackerAdapter, dbAdapter }));
  synthesizer.start();
  await delay(30);
  await synthesizer.stop();

  assert.equal(updateStatusCalls.length, 1, "exactly one update, for the matching-project parent only");
  assert.equal(updateStatusCalls[0]!.taskId, "this-project-parent");
  assert.equal(writes.length, 0);
});

test("#listIssues() requests scoped to the configured project via a project_id query param", async (t) => {
  const { requests } = mockFetch(t, { reviewIssues: [], childrenByParent: {} });

  const synthesizer = new VerdictSynthesizer(baseConfig({ projectId: "project-abc" }));
  synthesizer.start();
  await delay(20);
  await synthesizer.stop();

  const listRequest = requests.find((r) => !r.url.includes("/children"));
  assert.ok(listRequest, "should have made at least one list request");
  const params = new URL(listRequest!.url).searchParams;
  assert.equal(params.get("project_id"), "project-abc");
});

test("a review-status parent with a non-review-status sibling issue in the same response is skipped for that sibling", async (t) => {
  const { adapter: trackerAdapter, updateStatusCalls } = makeFakeTrackerAdapter();
  const { adapter: dbAdapter, writes } = makeFakeDbAdapter();
  mockFetch(t, {
    reviewIssues: [
      { id: "todo-issue", status: "todo", project_id: "project-1" },
      { id: "in-progress-issue", status: "in_progress", project_id: "project-1" },
    ],
    childrenByParent: {},
  });

  const synthesizer = new VerdictSynthesizer(baseConfig());
  synthesizer.start();
  await delay(30);
  await synthesizer.stop();

  assert.equal(updateStatusCalls.length, 0);
  assert.equal(writes.length, 0);
});
