import { test } from "node:test";
import assert from "node:assert/strict";
import { runTrackerAdapterContractTests } from "../../../contracts/test-harness/tracker-adapter.ts";
import { MulticaTrackerAdapter, loadMulticaConfig } from "./index.ts";

/**
 * Runs the generic TrackerAdapter contract harness
 * (contracts/test-harness/tracker-adapter.ts) against the REAL
 * MulticaTrackerAdapter, against the LIVE Multica instance described by
 * `~/.multica/config.json` — no fakes, no mocking of fetch.
 *
 * The harness has no task-creation method of its own (TrackerAdapter
 * itself has none — claimTask/updateStatus/getTask all operate on
 * pre-existing tasks), so this file provisions ONE real Multica issue as
 * the harness's `knownTaskId` before running it, and deletes that issue
 * afterward regardless of pass/fail (try/finally), then verifies via a
 * fresh `GET /api/issues` that no issue titled with this story's
 * "tracker-adapter-impl-dev:" prefix remains. A teammate ("lock-impl-dev")
 * may be creating/deleting their own issues in the same live workspace
 * concurrently — this file only asserts on its own prefix, never on the
 * workspace being empty overall.
 */

const PREFIX = "tracker-adapter-impl-dev:";

interface MulticaIssue {
  id: string;
  title: string;
}

function authHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

test("MulticaTrackerAdapter satisfies the generic TrackerAdapter contract harness (live Multica)", async () => {
  const config = loadMulticaConfig();
  const baseUrl = config.server_url.replace(/\/+$/, "");
  const headers = authHeaders(config.token);

  // Provision one real issue to act as the harness's knownTaskId.
  const createRes = await fetch(
    `${baseUrl}/api/issues?workspace_id=${config.workspace_id}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `${PREFIX} known task for TrackerAdapter contract harness`,
        description: "Created by auriga/adapters/multica/index.test.ts. Safe to delete.",
      }),
    },
  );
  assert.equal(
    createRes.status,
    201,
    `setup: creating the known-task issue must succeed (got ${createRes.status})`,
  );
  const known = (await createRes.json()) as MulticaIssue;

  try {
    const adapter = new MulticaTrackerAdapter(config);
    await runTrackerAdapterContractTests(adapter, { knownTaskId: known.id });
  } finally {
    const deleteRes = await fetch(
      `${baseUrl}/api/issues/${known.id}?workspace_id=${config.workspace_id}`,
      { method: "DELETE", headers },
    );
    assert.equal(
      deleteRes.status,
      204,
      `cleanup: deleting the known-task issue must succeed (got ${deleteRes.status})`,
    );
  }

  // Final verification: no "tracker-adapter-impl-dev:"-prefixed issue
  // remains in the workspace (teammate-created issues under a different
  // prefix are ignored on purpose).
  const listRes = await fetch(
    `${baseUrl}/api/issues?workspace_id=${config.workspace_id}`,
    { headers },
  );
  assert.equal(listRes.status, 200, `verification: listing issues must succeed (got ${listRes.status})`);
  const listBody = (await listRes.json()) as { issues: MulticaIssue[]; total: number };
  const leftover = listBody.issues.filter((issue) => issue.title.startsWith(PREFIX));
  assert.deepEqual(
    leftover,
    [],
    `verification: no "${PREFIX}"-prefixed issues should remain after cleanup, found: ${JSON.stringify(leftover)}`,
  );
});

/**
 * adapter-in-review-mapping (board-state-machine, stage 2): proves
 * getTask()/updateStatus() round-trip the contract's "review" status and
 * Multica's real "in_review" status faithfully in both directions, instead
 * of the old lossy collapse into "in_progress".
 *
 * Provisions its own real issue (same PREFIX/cleanup convention as the
 * contract-harness test above) so it can run independently of it.
 */
test("MulticaTrackerAdapter maps review <-> in_review faithfully (live round-trip)", async () => {
  const config = loadMulticaConfig();
  const baseUrl = config.server_url.replace(/\/+$/, "");
  const headers = authHeaders(config.token);

  const createRes = await fetch(
    `${baseUrl}/api/issues?workspace_id=${config.workspace_id}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `${PREFIX} known task for review<->in_review mapping test`,
        description: "Created by auriga/adapters/multica/index.test.ts. Safe to delete.",
      }),
    },
  );
  assert.equal(
    createRes.status,
    201,
    `setup: creating the known-task issue must succeed (got ${createRes.status})`,
  );
  const known = (await createRes.json()) as MulticaIssue;

  try {
    const adapter = new MulticaTrackerAdapter(config);

    await adapter.updateStatus(known.id, "review");

    // Verify the real HTTP call, not just updateStatus()'s return value: read
    // Multica's raw status directly, bypassing the adapter's own inverse
    // mapping (which could otherwise mask a bug where both directions are
    // wrong in a way that happens to cancel out).
    const rawGetRes = await fetch(
      `${baseUrl}/api/issues/${known.id}?workspace_id=${config.workspace_id}`,
      { headers },
    );
    assert.equal(rawGetRes.status, 200, `verification: raw GET must succeed (got ${rawGetRes.status})`);
    const rawIssue = (await rawGetRes.json()) as MulticaIssue & { status: string };
    assert.equal(
      rawIssue.status,
      "in_review",
      `updateStatus(id, "review") must PUT Multica status "in_review", got "${rawIssue.status}"`,
    );

    // Full round-trip: getTask() on that same in_review issue must report
    // the contract's "review", not the old lossy "in_progress".
    const task = await adapter.getTask(known.id);
    assert.equal(
      task.status,
      "review",
      `getTask() on an in_review issue must return status "review", got "${task.status}"`,
    );
  } finally {
    const deleteRes = await fetch(
      `${baseUrl}/api/issues/${known.id}?workspace_id=${config.workspace_id}`,
      { method: "DELETE", headers },
    );
    assert.equal(
      deleteRes.status,
      204,
      `cleanup: deleting the known-task issue must succeed (got ${deleteRes.status})`,
    );
  }
});
