import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DeadLetterEntry,
  DeadLetterQueueConfig,
  DeadLetterQueueStore,
} from "./types.js";
import Database from "better-sqlite3";

const DEFAULT_DLQ_CONFIG: DeadLetterQueueConfig = {
  maxSize: 1000,
};

const SQL_SCHEMA_VERSION = 1;

function serializePersistentValue(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === "bigint") {
      return {
        __agencType: "bigint",
        value: currentValue.toString(),
      };
    }
    if (currentValue instanceof Uint8Array) {
      return {
        __agencType: "uint8array",
        value: Array.from(currentValue),
      };
    }
    return currentValue;
  });
}

function deserializePersistentValue<T>(value: string): T {
  return JSON.parse(value, (_key, currentValue) => {
    if (
      currentValue &&
      typeof currentValue === "object" &&
      !Array.isArray(currentValue)
    ) {
      const tagged = currentValue as {
        __agencType?: string;
        value?: unknown;
      };
      if (tagged.__agencType === "bigint" && typeof tagged.value === "string") {
        return BigInt(tagged.value);
      }
      if (
        tagged.__agencType === "uint8array" &&
        Array.isArray(tagged.value)
      ) {
        return Uint8Array.from(tagged.value as number[]);
      }
    }
    return currentValue;
  }) as T;
}

export class SqliteDeadLetterQueue implements DeadLetterQueueStore {
  private db: any = null;
  private initializing = false;
  private readonly dbPath: string;
  private readonly maxSize: number;

  constructor(dbPath: string, config?: Partial<DeadLetterQueueConfig>) {
    this.dbPath = dbPath;
    this.maxSize = config?.maxSize ?? DEFAULT_DLQ_CONFIG.maxSize;
  }

  add(entry: DeadLetterEntry): void {
    const db = this.getDb();
    const payload = serializePersistentValue(entry);
    const now = Date.now();
    db.prepare(
      `INSERT INTO dead_letter_queue (task_pda, failed_at, payload, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_pda) DO UPDATE SET
         failed_at = excluded.failed_at,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
    ).run(entry.taskPda, entry.failedAt, payload, now);
    this.trimToMaxSize(db);
  }

  getAll(): DeadLetterEntry[] {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT payload
         FROM dead_letter_queue
         ORDER BY failed_at ASC, rowid ASC`,
      )
      .all() as ReadonlyArray<{ payload: string }>;
    return rows.map((row) =>
      deserializePersistentValue<DeadLetterEntry>(row.payload),
    );
  }

  getByTaskId(taskPda: string): DeadLetterEntry | undefined {
    const row = this.getDb()
      .prepare(`SELECT payload FROM dead_letter_queue WHERE task_pda = ?`)
      .get(taskPda) as { payload: string } | undefined;
    return row
      ? deserializePersistentValue<DeadLetterEntry>(row.payload)
      : undefined;
  }

  retry(taskPda: string): DeadLetterEntry | undefined {
    const existing = this.getByTaskId(taskPda);
    if (!existing) {
      return undefined;
    }
    this.getDb()
      .prepare(`DELETE FROM dead_letter_queue WHERE task_pda = ?`)
      .run(taskPda);
    return existing;
  }

  remove(taskPda: string): boolean {
    const result = this.getDb()
      .prepare(`DELETE FROM dead_letter_queue WHERE task_pda = ?`)
      .run(taskPda);
    return result.changes > 0;
  }

  size(): number {
    const row = this.getDb()
      .prepare(`SELECT COUNT(*) AS count FROM dead_letter_queue`)
      .get() as { count: number };
    return row.count;
  }

  clear(): void {
    this.getDb().prepare(`DELETE FROM dead_letter_queue`).run();
  }

  close(): void {
    if (!this.db) {
      return;
    }
    this.db.close();
    this.db = null;
  }

  private trimToMaxSize(db: any): void {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM dead_letter_queue`)
      .get() as { count: number };
    const overflow = row.count - this.maxSize;
    if (overflow <= 0) {
      return;
    }
    db.prepare(
      `DELETE FROM dead_letter_queue
       WHERE rowid IN (
         SELECT rowid
         FROM dead_letter_queue
         ORDER BY failed_at ASC, rowid ASC
         LIMIT ?
       )`,
    ).run(overflow);
  }

  private getDb(): any {
    if (this.db) {
      return this.db;
    }
    if (this.initializing) {
      throw new Error("SqliteDeadLetterQueue: concurrent initialization detected");
    }
    this.initializing = true;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS dead_letter_queue_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          schema_version INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO dead_letter_queue_meta (id, schema_version)
        VALUES (1, ${SQL_SCHEMA_VERSION});

        CREATE TABLE IF NOT EXISTS dead_letter_queue (
          task_pda TEXT PRIMARY KEY,
          failed_at INTEGER NOT NULL,
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_failed_at
          ON dead_letter_queue(failed_at ASC);
      `);
      return this.db;
    } finally {
      this.initializing = false;
    }
  }
}
