import Database from "better-sqlite3";
import type { DBAdapter } from "../../../contracts/db-adapter.ts";

/**
 * SqliteDBAdapter — a local-cache DBAdapter implementation backed by
 * better-sqlite3 (AD-6).
 *
 * This is a local read/write cache only: it has no notion of a
 * system-of-record, replication, or distributed locking — that role
 * belongs to Multica elsewhere in this epic. This adapter's only job
 * is to satisfy the DBAdapter contract (contracts/db-adapter.ts)
 * against a sqlite file on disk.
 *
 * Values are JSON-serialized into a single TEXT column. Reads of a
 * missing key resolve to `null` rather than throwing. better-sqlite3
 * is synchronous under the hood; methods are `async` only to conform
 * to the Promise-returning DBAdapter interface.
 */
export class SqliteDBAdapter implements DBAdapter {
  #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  async read<T>(key: string): Promise<T | null> {
    const row = this.#db
      .prepare<[string], { value: string }>("SELECT value FROM kv WHERE key = ?")
      .get(key);

    if (row === undefined) {
      return null;
    }

    return JSON.parse(row.value) as T;
  }

  async write<T>(key: string, value: T): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  /** Closes the underlying sqlite connection. */
  close(): void {
    this.#db.close();
  }
}
