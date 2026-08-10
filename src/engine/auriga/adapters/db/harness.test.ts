import { test } from "node:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runDBAdapterContractTests } from "../../../contracts/test-harness/db-adapter.ts";
import { SqliteDBAdapter } from "./index.ts";

/**
 * Re-verifies the REAL SqliteDBAdapter against the generic DBAdapter
 * contract harness (contracts/test-harness/db-adapter.ts), now that the
 * harness exists. index.test.ts's assertions were hand-written before the
 * harness existed (per the contracts-test-harness story's flagged gap) —
 * this file closes that gap by running the same shared harness the fake
 * DBAdapter implementations in contracts/test-harness/db-adapter.test.ts
 * run, against the real sqlite-backed adapter instead of a fake.
 */
function scratchDbPath(): string {
  return join(tmpdir(), `auriga-db-adapter-harness-${randomUUID()}.sqlite`);
}

test("SqliteDBAdapter satisfies the generic DBAdapter contract harness", async () => {
  const dbPath = scratchDbPath();
  const adapter = new SqliteDBAdapter(dbPath);
  try {
    await runDBAdapterContractTests(adapter);
  } finally {
    adapter.close();
    rmSync(dbPath, { force: true });
  }
});
