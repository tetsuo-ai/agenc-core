import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheckpointStore, TaskCheckpoint } from "./types.js";
import Database from "better-sqlite3";
import {
  migrateTaskCheckpoint,
  serializeTaskCheckpoint,
} from "../workflow/migrations.js";
import { RuntimeSchemaCompatibilityError } from "../workflow/schema-version.js";

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

export class SqliteCheckpointStore implements CheckpointStore {
  private db: any = null;
  private dbPromise: Promise<any> | null = null;

  constructor(private readonly dbPath: string) {}

  async save(checkpoint: TaskCheckpoint): Promise<void> {
    const db = await this.getDb();
    const persisted = serializeTaskCheckpoint(checkpoint);
    db.prepare(
      `INSERT INTO task_checkpoints (
         task_pda,
         stage,
         payload,
         created_at,
         updated_at
      ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_pda) DO UPDATE SET
         stage = excluded.stage,
         payload = excluded.payload,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
    ).run(
      persisted.taskPda,
      persisted.stage,
      serializePersistentValue(persisted),
      persisted.createdAt,
      persisted.updatedAt,
    );
  }

  async load(taskPda: string): Promise<TaskCheckpoint | null> {
    const db = await this.getDb();
    const row = db
      .prepare(`SELECT payload FROM task_checkpoints WHERE task_pda = ?`)
      .get(taskPda) as { payload: string } | undefined;
    if (!row) {
      return null;
    }
    const migration = migrateTaskCheckpoint(
      deserializePersistentValue<TaskCheckpoint>(row.payload),
    );
    if (migration.migrated) {
      await this.save(migration.value);
    }
    return migration.value;
  }

  async remove(taskPda: string): Promise<void> {
    const db = await this.getDb();
    db.prepare(`DELETE FROM task_checkpoints WHERE task_pda = ?`).run(taskPda);
  }

  async listPending(): Promise<TaskCheckpoint[]> {
    const db = await this.getDb();
    const rows = db
      .prepare(
        `SELECT payload
         FROM task_checkpoints
         ORDER BY updated_at ASC, task_pda ASC`,
      )
      .all() as ReadonlyArray<{ payload: string }>;
    const checkpoints: TaskCheckpoint[] = [];
    for (const row of rows) {
      const migration = migrateTaskCheckpoint(
        deserializePersistentValue<TaskCheckpoint>(row.payload),
      );
      if (migration.migrated) {
        await this.save(migration.value);
      }
      checkpoints.push(migration.value);
    }
    return checkpoints;
  }

  async close(): Promise<void> {
    if (!this.db) {
      return;
    }
    this.db.close();
    this.db = null;
  }

  private async getDb(): Promise<any> {
    if (this.db) {
      return this.db;
    }
    if (this.dbPromise) {
      return this.dbPromise;
    }
    this.dbPromise = this.initDb();
    try {
      this.db = await this.dbPromise;
    } finally {
      this.dbPromise = null;
    }
    return this.db;
  }

  private async initDb(): Promise<any> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_checkpoint_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO task_checkpoint_meta (id, schema_version)
      VALUES (1, ${SQL_SCHEMA_VERSION});

      CREATE TABLE IF NOT EXISTS task_checkpoints (
        task_pda TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_checkpoints_updated_at
        ON task_checkpoints(updated_at ASC);
    `);
    const versionRow = db
      .prepare(`SELECT schema_version FROM task_checkpoint_meta WHERE id = 1`)
      .get() as { schema_version?: number } | undefined;
    if (
      typeof versionRow?.schema_version === "number" &&
      versionRow.schema_version !== SQL_SCHEMA_VERSION
    ) {
      throw new RuntimeSchemaCompatibilityError({
        schemaName: "TaskCheckpointSQLiteStore",
        receivedVersion: versionRow.schema_version,
        supportedVersions: [SQL_SCHEMA_VERSION],
      });
    }
    return db;
  }
}
