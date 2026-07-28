import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type FindingCategory = "stall" | "dispatch_gap" | "ship_gap" | "infra";

export interface FindingInput {
  id: string;
  category: FindingCategory;
  title: string;
  timestamp?: Date | number;
}

export interface FindingRecord {
  id: string;
  category: FindingCategory;
  title: string;
  first_seen: number;
  last_seen: number;
  occurrence_count: number;
  auto_recovered_count: number;
  escalated_count: number;
}

export interface StateTrackerOptions {
  busyTimeoutMs?: number;
  enableWal?: boolean;
  logger?: Pick<Console, "debug" | "warn">;
}

type SqliteDatabase = Database.Database;

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export class StateTracker {
  private readonly logger: Pick<Console, "debug" | "warn">;
  private readonly busyTimeoutMs: number;
  private readonly enableWal: boolean;
  private db: SqliteDatabase | null = null;

  constructor(
    private readonly databasePath: string,
    options: StateTrackerOptions = {},
  ) {
    this.logger = options.logger ?? console;
    this.busyTimeoutMs = Math.max(
      0,
      Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS),
    );
    this.enableWal = options.enableWal ?? true;

    try {
      if (databasePath !== ":memory:") {
        mkdirSync(dirname(databasePath), { recursive: true });
      }

      this.db = new Database(databasePath);
      this.db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);

      if (this.enableWal && databasePath !== ":memory:") {
        this.db.pragma("journal_mode = WAL");
      }
    } catch (error) {
      this.warn("open", undefined, error);
      this.db = null;
    }
  }

  initialize(): boolean {
    return this.withDatabase("initialize", undefined, (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS findings_history (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          occurrence_count INTEGER DEFAULT 1,
          auto_recovered_count INTEGER DEFAULT 0,
          escalated_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS auto_filed_items (
          item_id TEXT PRIMARY KEY,
          finding_id TEXT NOT NULL,
          filed_at INTEGER NOT NULL,
          item_type TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_findings_category
          ON findings_history(category);
        CREATE INDEX IF NOT EXISTS idx_findings_last_seen
          ON findings_history(last_seen);
      `);

      this.debug("initialize");
      return true;
    }, false);
  }

  recordFinding(finding: FindingInput): FindingRecord | null {
    const seenAt = toEpochSeconds(finding.timestamp ?? new Date());

    return this.withDatabase("recordFinding", finding.id, (db) => {
      db.prepare(`
        INSERT INTO findings_history (
          id,
          category,
          title,
          first_seen,
          last_seen,
          occurrence_count,
          auto_recovered_count,
          escalated_count
        )
        VALUES (@id, @category, @title, @seenAt, @seenAt, 1, 0, 0)
        ON CONFLICT(id) DO UPDATE SET
          category = excluded.category,
          title = excluded.title,
          last_seen = MAX(findings_history.last_seen, excluded.last_seen),
          occurrence_count = findings_history.occurrence_count + 1
      `).run({
        id: finding.id,
        category: finding.category,
        title: finding.title,
        seenAt,
      });

      this.debug("recordFinding", finding.id);
      return this.getFinding(finding.id);
    }, null);
  }

  getFinding(id: string): FindingRecord | null {
    return this.withDatabase("getFinding", id, (db) => {
      const record = db
        .prepare("SELECT * FROM findings_history WHERE id = ?")
        .get(id) as FindingRecord | undefined;

      this.debug("getFinding", id);
      return record ?? null;
    }, null);
  }

  getRecurringFindings(
    windowSeconds: number,
    occurrenceThreshold: number,
    now: Date | number = new Date(),
  ): FindingRecord[] {
    const earliestSeen = toEpochSeconds(now) - windowSeconds;

    return this.withDatabase("getRecurringFindings", undefined, (db) => {
      const records = db.prepare(`
        SELECT *
        FROM findings_history
        WHERE last_seen >= ?
          AND occurrence_count >= ?
        ORDER BY occurrence_count DESC, last_seen DESC, id ASC
      `).all(earliestSeen, occurrenceThreshold) as FindingRecord[];

      this.debug("getRecurringFindings");
      return records;
    }, []);
  }

  recordAutoRecovery(findingId: string): FindingRecord | null {
    return this.incrementCounter(
      findingId,
      "auto_recovered_count",
      "recordAutoRecovery",
    );
  }

  recordEscalation(findingId: string): FindingRecord | null {
    return this.incrementCounter(findingId, "escalated_count", "recordEscalation");
  }

  close(): void {
    if (!this.db) {
      return;
    }

    try {
      this.db.close();
    } catch (error) {
      this.warn("close", undefined, error);
    } finally {
      this.db = null;
    }
  }

  private incrementCounter(
    findingId: string,
    column: "auto_recovered_count" | "escalated_count",
    operation: string,
  ): FindingRecord | null {
    return this.withDatabase(operation, findingId, (db) => {
      db.prepare(`
        UPDATE findings_history
        SET ${column} = ${column} + 1
        WHERE id = ?
      `).run(findingId);

      this.debug(operation, findingId);
      return this.getFinding(findingId);
    }, null);
  }

  private withDatabase<T>(
    operation: string,
    findingId: string | undefined,
    callback: (db: SqliteDatabase) => T,
    fallback: T,
  ): T {
    if (!this.db) {
      this.warn(operation, findingId, new Error("state tracker unavailable"));
      return fallback;
    }

    try {
      return callback(this.db);
    } catch (error) {
      this.warn(operation, findingId, error);
      return fallback;
    }
  }

  private debug(operation: string, findingId?: string): void {
    this.logger.debug?.("state_tracker.operation", { operation, findingId });
  }

  private warn(operation: string, findingId: string | undefined, error: unknown): void {
    this.logger.warn?.("state_tracker.warning", {
      operation,
      findingId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function toEpochSeconds(value: Date | number): number {
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1_000);
  }

  return Math.floor(value);
}
