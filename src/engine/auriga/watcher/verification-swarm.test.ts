// auriga/watcher/verification-swarm.test.ts — tests VerificationSwarmDispatcher
// against a mocked Multica HTTP layer (node:test's `t.mock.method` on
// `globalThis.fetch`), mirroring auriga/watcher/index.test.ts's existing
// mocking pattern for this same watcher/dispatch family of components.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  VerificationSwarmDispatcher,
  type VerificationSwarmDispatcherConfig,
  type VerifierPoolEntry,
} from "./verification-swarm.ts";

const POOL: VerifierPoolEntry[] = [
  { id: "verifier-agent-1", type: "agent" },
  { id: "verifier-agent-2", type: "agent" },
  { id: "verifier-member-3", type: "member" },
];

function baseConfig(overrides: Partial<VerificationSwarmDispatcherConfig> = {}): VerificationSwarmDispatcherConfig {
  return {
    serverUrl: "http://fake-multica.test",
    workspaceId: "ws-1",
    projectId: "project-1",
    token: "fake-token",
    verifierPool: POOL,
    ...overrides,
  };
}

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

/** Wires a fetch mock that answers GET .../children with `childrenByParent`
 * (defaulting an unlisted parent to no children) and records every request,
 * answering POST /api/issues by minting a fake created issue. */
function mockFetch(
  t: { mock: { method: (...args: any[]) => unknown } },
  opts: { childrenByParent?: Record<string, unknown[]> } = {},
): { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let createdCounter = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ method, url, body });

    if (method === "GET" && url.includes("/children")) {
      const parentId = new URL(url).pathname.split("/").at(-2);
      const issues = opts.childrenByParent?.[parentId ?? ""] ?? [];
      return new Response(JSON.stringify({ issues }), { status: 200 });
    }

    if (method === "POST" && url.includes("/api/issues")) {
      createdCounter++;
      const created = {
        id: `sub-issue-${createdCounter}`,
        status: "todo",
        ...body,
      };
      return new Response(JSON.stringify(created), { status: 201 });
    }

    throw new Error(`mockFetch: unexpected request ${method} ${url}`);
  });
  return { requests };
}

test("creates N sub-issues via POST /api/issues with --parent/--stage-equivalent fields, one per distinct pool assignee", async (t) => {
  const { requests } = mockFetch(t, { childrenByParent: {} });
  const dispatcher = new VerificationSwarmDispatcher(baseConfig());

  await dispatcher.handleReviewEligible({ issueId: "parent-1" });

  const posts = requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, POOL.length, "should create exactly one sub-issue per pool verifier");

  const assigneeIds = posts.map((p) => (p.body as { assignee_id: string }).assignee_id);
  assert.deepEqual(new Set(assigneeIds), new Set(POOL.map((v) => v.id)), "each sub-issue must go to a distinct pool assignee");

  for (const post of posts) {
    const body = post.body as Record<string, unknown>;
    assert.equal(body.parent_issue_id, "parent-1");
    assert.equal(body.stage, 1);
    assert.equal(body.project_id, "project-1");
  }
});

test("checks multica issue children BEFORE creating anything", async (t) => {
  const { requests } = mockFetch(t, { childrenByParent: {} });
  const dispatcher = new VerificationSwarmDispatcher(baseConfig());

  await dispatcher.handleReviewEligible({ issueId: "parent-2" });

  const firstRequest = requests[0];
  assert.ok(firstRequest, "at least one request should have been made");
  assert.equal(firstRequest.method, "GET");
  assert.ok(firstRequest.url.includes("/children"), "the first call must be the children idempotency check");
});

test("idempotency: a review-eligible event fired twice for the same issue does not create duplicate sub-issues", async (t) => {
  const existingChildren = POOL.map((v, i) => ({
    id: `existing-sub-${i}`,
    status: "todo",
    parent_issue_id: "parent-3",
    stage: 1,
    assignee_id: v.id,
  }));
  const { requests } = mockFetch(t, { childrenByParent: { "parent-3": [] } });
  const dispatcher = new VerificationSwarmDispatcher(baseConfig());

  // First dispatch: no existing children -> creates the swarm.
  await dispatcher.handleReviewEligible({ issueId: "parent-3" });
  const postsAfterFirst = requests.filter((r) => r.method === "POST").length;
  assert.equal(postsAfterFirst, POOL.length);

  // Simulate a watcher restart re-detecting the same review-eligible
  // transition: a FRESH dispatcher instance (no in-memory state carried
  // over), and Multica now reports the previously-created children.
  const { requests: secondRunRequests } = mockFetch(t, {
    childrenByParent: { "parent-3": existingChildren },
  });
  const secondDispatcher = new VerificationSwarmDispatcher(baseConfig());
  await secondDispatcher.handleReviewEligible({ issueId: "parent-3" });

  const postsInSecondRun = secondRunRequests.filter((r) => r.method === "POST").length;
  assert.equal(postsInSecondRun, 0, "no new sub-issues should be created once children already exist");
});

test("idempotency: firing handleReviewEligible twice in a row on the SAME instance also creates no duplicates", async (t) => {
  const childrenByParent: Record<string, unknown[]> = { "parent-4": [] };
  const { requests } = mockFetch(t, { childrenByParent });
  const dispatcher = new VerificationSwarmDispatcher(baseConfig());

  await dispatcher.handleReviewEligible({ issueId: "parent-4" });
  const created = requests.filter((r) => r.method === "POST").map((r) => (r.body as { assignee_id: string }).assignee_id);
  // Reflect that Multica now has children for this parent, exactly like a
  // real second poll of the live API would see after the first dispatch.
  childrenByParent["parent-4"] = created.map((assigneeId, i) => ({
    id: `existing-${i}`,
    status: "todo",
    parent_issue_id: "parent-4",
    stage: 1,
    assignee_id: assigneeId,
  }));

  await dispatcher.handleReviewEligible({ issueId: "parent-4" });

  const totalPosts = requests.filter((r) => r.method === "POST").length;
  assert.equal(totalPosts, POOL.length, "second call must not create additional sub-issues");
});

test("never issues a write (PUT/PATCH) against the parent issue itself -- parent status is left untouched", async (t) => {
  const { requests } = mockFetch(t, { childrenByParent: {} });
  const dispatcher = new VerificationSwarmDispatcher(baseConfig());

  await dispatcher.handleReviewEligible({ issueId: "parent-5" });

  const writesToParent = requests.filter(
    (r) => (r.method === "PUT" || r.method === "PATCH") && r.url.includes("parent-5") && !r.url.includes("/children"),
  );
  assert.equal(writesToParent.length, 0, "the dispatcher must never write to the parent issue's own resource");
});

test("emits swarm-dispatched with the parent issueId and created sub-issue ids on success", async (t) => {
  mockFetch(t, { childrenByParent: {} });
  const dispatcher = new VerificationSwarmDispatcher(baseConfig());

  const events: unknown[] = [];
  dispatcher.on("swarm-dispatched", (e) => events.push(e));

  await dispatcher.handleReviewEligible({ issueId: "parent-6" });

  assert.equal(events.length, 1);
  const event = events[0] as { issueId: string; subIssueIds: string[] };
  assert.equal(event.issueId, "parent-6");
  assert.equal(event.subIssueIds.length, POOL.length);
});

test("emits swarm-skipped (not swarm-dispatched) when children already exist", async (t) => {
  mockFetch(t, {
    childrenByParent: {
      "parent-7": [{ id: "existing-1", status: "todo", parent_issue_id: "parent-7", stage: 1 }],
    },
  });
  const dispatcher = new VerificationSwarmDispatcher(baseConfig());

  const dispatchedEvents: unknown[] = [];
  const skippedEvents: unknown[] = [];
  dispatcher.on("swarm-dispatched", (e) => dispatchedEvents.push(e));
  dispatcher.on("swarm-skipped", (e) => skippedEvents.push(e));

  await dispatcher.handleReviewEligible({ issueId: "parent-7" });

  assert.equal(dispatchedEvents.length, 0);
  assert.equal(skippedEvents.length, 1);
  assert.equal((skippedEvents[0] as { issueId: string }).issueId, "parent-7");
});

test("attach() wires a watcher's review-eligible events into the dispatcher automatically", async (t) => {
  const { requests } = mockFetch(t, { childrenByParent: {} });
  const dispatcher = new VerificationSwarmDispatcher(baseConfig());
  const watcher = new EventEmitter();
  dispatcher.attach(watcher);

  const dispatched: unknown[] = [];
  dispatcher.on("swarm-dispatched", (e) => dispatched.push(e));

  watcher.emit("review-eligible", { issueId: "parent-8", previousStatus: "in_progress" });

  // handleReviewEligible is async; let its promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(dispatched.length, 1);
  assert.equal(requests.filter((r) => r.method === "POST").length, POOL.length);
});

test("attach() emits swarm-error (not an unhandled rejection) when the underlying dispatch fails", async (t) => {
  (t as any).mock.method(globalThis, "fetch", async () => {
    return new Response("boom", { status: 500 });
  });
  const dispatcher = new VerificationSwarmDispatcher(baseConfig());
  const watcher = new EventEmitter();
  dispatcher.attach(watcher);

  const errors: unknown[] = [];
  dispatcher.on("swarm-error", (e) => errors.push(e));

  watcher.emit("review-eligible", { issueId: "parent-9" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(errors.length, 1);
  assert.equal((errors[0] as { issueId: string }).issueId, "parent-9");
});

test("two review-eligible events for the SAME issue firing back-to-back (before the first's children-check resolves) still create exactly one swarm", async (t) => {
  let resolveChildrenGet: (() => void) | undefined;
  let childrenGetCallCount = 0;
  const postBodies: unknown[] = [];
  (t as any).mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/children")) {
      childrenGetCallCount++;
      if (childrenGetCallCount === 1) {
        await new Promise<void>((resolve) => {
          resolveChildrenGet = resolve;
        });
      }
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    }
    if (method === "POST") {
      const body = JSON.parse(init!.body as string);
      postBodies.push(body);
      return new Response(JSON.stringify({ id: `sub-${postBodies.length}`, status: "todo", ...body }), { status: 201 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });

  const dispatcher = new VerificationSwarmDispatcher(baseConfig());

  const first = dispatcher.handleReviewEligible({ issueId: "parent-10" });
  // Give the first call a tick to reach and call fetch for its children check.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = dispatcher.handleReviewEligible({ issueId: "parent-10" });

  resolveChildrenGet?.();
  await Promise.all([first, second]);

  assert.equal(postBodies.length, POOL.length, "concurrent calls for the same issue must not double-dispatch");
});

test("constructor rejects an empty verifier pool", () => {
  assert.throws(() => new VerificationSwarmDispatcher(baseConfig({ verifierPool: [] })));
});

test("constructor rejects a pool with duplicate assignee ids (would violate the distinct-assignee requirement)", () => {
  assert.throws(() =>
    new VerificationSwarmDispatcher(
      baseConfig({
        verifierPool: [
          { id: "same-id", type: "agent" },
          { id: "same-id", type: "member" },
        ],
      }),
    ),
  );
});

test("constructor rejects a verifierCount larger than the pool size", () => {
  assert.throws(() => new VerificationSwarmDispatcher(baseConfig({ verifierCount: POOL.length + 1 })));
});

test("verifierCount, when explicitly smaller than the pool, dispatches only that many sub-issues", async (t) => {
  mockFetch(t, { childrenByParent: {} });
  const dispatcher = new VerificationSwarmDispatcher(baseConfig({ verifierCount: 2 }));

  const events: unknown[] = [];
  dispatcher.on("swarm-dispatched", (e) => events.push(e));
  await dispatcher.handleReviewEligible({ issueId: "parent-11" });

  const event = events[0] as { subIssueIds: string[] };
  assert.equal(event.subIssueIds.length, 2);
});
