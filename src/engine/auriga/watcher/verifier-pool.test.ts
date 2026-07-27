// auriga/watcher/verifier-pool.test.ts — locks the live Auriga verifier pool
// to dedicated Multica agent identities, not the operator-member stand-in used
// during the original P2 acceptance run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AURIGA_VERIFIER_POOL } from "./verifier-pool.ts";

test("Auriga verifier pool has at least two distinct dedicated agent assignees", () => {
  assert.ok(AURIGA_VERIFIER_POOL.length >= 2, "real verification swarms require N >= 2");

  const ids = AURIGA_VERIFIER_POOL.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "every configured verifier must be a distinct assignee");
  assert.ok(AURIGA_VERIFIER_POOL.every((entry) => entry.type === "agent"), "production verifiers must be agent identities");
});

test("Auriga verifier pool uses the provisioned verifier identities", () => {
  assert.deepEqual(AURIGA_VERIFIER_POOL, [
    { id: "d2097159-285c-43b8-86c7-4a2a5cb1d5d9", type: "agent" },
    { id: "25238152-6c2f-4959-bd05-7e53532c3969", type: "agent" },
  ]);
});
