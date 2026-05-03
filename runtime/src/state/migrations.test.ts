import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  LOGS_DB_MIGRATIONS,
  STATE_DB_MIGRATIONS,
  type SqlMigration,
} from "./migrations/index.js";
import { applyMigrations } from "./sqlite-driver.js";

const migrationDir = dirname(fileURLToPath(import.meta.url));

describe("state migration registry", () => {
  it("loads state migrations from numbered migration files in order", () => {
    expect(STATE_DB_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(STATE_DB_MIGRATIONS.map((migration) => migration.name)).toEqual([
      "initial_state_schema",
      "csv_agent_jobs_schema",
      "agent_runs_schema",
      "session_state_snapshots_schema",
      "in_flight_tool_calls_schema",
      "thread_model_provider_columns",
      "session_agent_links_schema",
      "tool_output_rotation_schema",
    ]);
    expectMigrationVersionsAreUnique(STATE_DB_MIGRATIONS);
  });

  it("loads logs migrations from numbered migration files in order", () => {
    expect(LOGS_DB_MIGRATIONS.map((migration) => migration.version)).toEqual([1]);
    expect(LOGS_DB_MIGRATIONS.map((migration) => migration.name)).toEqual([
      "initial_logs_schema",
    ]);
    expectMigrationVersionsAreUnique(LOGS_DB_MIGRATIONS);
  });

  it("keeps versioned migration files under the migration directory", () => {
    const files = readdirSync(join(migrationDir, "migrations"));
    expect(files.filter((file) => /^\d+_.*\.ts$/.test(file)).sort()).toEqual([
      "001_initial_logs_schema.ts",
      "001_initial_state_schema.ts",
      "002_csv_agent_jobs_schema.ts",
      "003_agent_runs_schema.ts",
      "004_session_state_snapshots_schema.ts",
      "005_in_flight_tool_calls_schema.ts",
      "006_thread_model_provider_columns.ts",
      "007_session_agent_links_schema.ts",
      "008_tool_output_rotation_schema.ts",
    ]);
  });

  it("repairs older threads tables missing model/provider columns", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO schema_migrations (version, name) VALUES
          (1, 'initial_state_schema'),
          (2, 'csv_agent_jobs_schema'),
          (3, 'agent_runs_schema'),
          (4, 'session_state_snapshots_schema'),
          (5, 'in_flight_tool_calls_schema');
        CREATE TABLE threads (
          thread_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE in_flight_tool_calls (
          session_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          args_json TEXT NOT NULL,
          status TEXT NOT NULL,
          output_partial TEXT,
          started_at TEXT NOT NULL,
          PRIMARY KEY (session_id, tool_call_id)
        );
      `);

      applyMigrations(db, STATE_DB_MIGRATIONS);

      const columns = db
        .prepare<[], { name: string }>("PRAGMA table_info(threads)")
        .all()
        .map((row) => row.name);
      expect(columns).toContain("model");
      expect(columns).toContain("model_provider");
      expect(
        db
          .prepare<[], { version: number }>(
            "SELECT version FROM schema_migrations WHERE version = 6",
          )
          .get()?.version,
      ).toBe(6);
    } finally {
      db.close();
    }
  });

  it("records migration 006 when the columns already exist", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO schema_migrations (version, name) VALUES
          (1, 'initial_state_schema'),
          (2, 'csv_agent_jobs_schema'),
          (3, 'agent_runs_schema'),
          (4, 'session_state_snapshots_schema'),
          (5, 'in_flight_tool_calls_schema');
        CREATE TABLE threads (
          thread_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          model TEXT,
          model_provider TEXT
        );
        CREATE TABLE in_flight_tool_calls (
          session_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          args_json TEXT NOT NULL,
          status TEXT NOT NULL,
          output_partial TEXT,
          started_at TEXT NOT NULL,
          PRIMARY KEY (session_id, tool_call_id)
        );
      `);

      applyMigrations(db, STATE_DB_MIGRATIONS);

      expect(
        db
          .prepare<[], { version: number }>(
            "SELECT version FROM schema_migrations WHERE version = 6",
          )
          .get()?.version,
      ).toBe(6);
    } finally {
      db.close();
    }
  });
});

function expectMigrationVersionsAreUnique(
  migrations: readonly SqlMigration[],
): void {
  const versions = migrations.map((migration) => migration.version);
  expect(new Set(versions).size).toBe(versions.length);
}
