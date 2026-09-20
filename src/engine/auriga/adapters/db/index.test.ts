import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DBAdapter } from "../../../contracts/db-adapter.ts";
import { SqliteDBAdapter } from "./index.ts";

function scratchDbPath(): string {
  return join(tmpdir(), `auriga-db-adapter-${randomUUID()}.sqlite`);
}

test("write() then read() round-trips a value for the same key", async () => {
  const dbPath = scratchDbPath();
  const adapter: DBAdapter & { close(): void } = new SqliteDBAdapter(dbPath);

  try {
    interface Widget {
      id: string;
      count: number;
    }

    const widget: Widget = { id: "widget-1", count: 42 };

    await adapter.write<Widget>("widget:1", widget);
    const result = await adapter.read<Widget>("widget:1");

    assert.deepEqual(result, widget);
  } finally {
    adapter.close();
    rmSync(dbPath, { force: true });
  }
});

test("read() on a missing key returns null, not an error", async () => {
  const dbPath = scratchDbPath();
  const adapter: DBAdapter & { close(): void } = new SqliteDBAdapter(dbPath);

  try {
    const result = await adapter.read<{ nope: true }>("does-not-exist");

    assert.equal(result, null);
  } finally {
    adapter.close();
    rmSync(dbPath, { force: true });
  }
});

test("value round-trips across a simulated process restart (fresh instance, same file)", async () => {
  const dbPath = scratchDbPath();

  interface Session {
    userId: string;
    active: boolean;
  }

  const session: Session = { userId: "user-42", active: true };

  try {
    // "Process 1": open, write, then close — simulating shutdown.
    const writer = new SqliteDBAdapter(dbPath);
    await writer.write<Session>("session:42", session);
    writer.close();

    assert.equal(existsSync(dbPath), true);

    // "Process 2": a brand new instance pointed at the same file on disk.
    const reader = new SqliteDBAdapter(dbPath);
    const result = await reader.read<Session>("session:42");
    reader.close();

    assert.deepEqual(result, session);
  } finally {
    rmSync(dbPath, { force: true });
  }
});
