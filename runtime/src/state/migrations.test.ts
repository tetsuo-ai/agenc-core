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
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
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
      "agent_run_metadata_schema",
      "tool_recovery_category_schema",
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
      "009_agent_run_metadata_schema.ts",
      "010_tool_recovery_category_schema.ts",
    ]);
  });

  it("adds agent run metadata to legacy agent_runs tables idempotently", () => {
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
          (5, 'in_flight_tool_calls_schema'),
          (6, 'thread_model_provider_columns'),
          (7, 'session_agent_links_schema'),
          (8, 'tool_output_rotation_schema');
        CREATE TABLE agent_runs (
          id TEXT PRIMARY KEY,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          last_active_at TEXT NOT NULL,
          current_session_id TEXT,
          created_by_client TEXT,
          last_snapshot_at TEXT
        );
      `);

      applyMigrations(db, STATE_DB_MIGRATIONS);
      applyMigrations(db, STATE_DB_MIGRATIONS);

      const columns = db
        .prepare<[], { name: string }>("PRAGMA table_info(agent_runs)")
        .all()
        .map((row) => row.name);
      expect(columns.filter((name) => name === "metadata_json")).toEqual([
        "metadata_json",
      ]);
      expect(
        db
          .prepare<[], { version: number }>(
            "SELECT version FROM schema_migrations WHERE version = 9",
          )
          .get()?.version,
      ).toBe(9);
    } finally {
      db.close();
    }
  });

  it("adds tool recovery category to legacy in-flight tool tables idempotently", () => {
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
          (5, 'in_flight_tool_calls_schema'),
          (6, 'thread_model_provider_columns'),
          (7, 'session_agent_links_schema'),
          (8, 'tool_output_rotation_schema'),
          (9, 'agent_run_metadata_schema');
        CREATE TABLE in_flight_tool_calls (
          session_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          args_json TEXT NOT NULL,
          status TEXT NOT NULL,
          output_partial TEXT,
          started_at TEXT NOT NULL,
          output_log_path TEXT,
          output_log_bytes INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, tool_call_id)
        );
      `);

      applyMigrations(db, STATE_DB_MIGRATIONS);
      applyMigrations(db, STATE_DB_MIGRATIONS);

      const columns = db
        .prepare<[], { name: string }>("PRAGMA table_info(in_flight_tool_calls)")
        .all()
        .map((row) => row.name);
      expect(columns.filter((name) => name === "recovery_category")).toEqual([
        "recovery_category",
      ]);
      db.prepare(
        `INSERT INTO in_flight_tool_calls (
          session_id,
          tool_call_id,
          tool_name,
          args_json,
          status,
          output_partial,
          started_at
        ) VALUES ('session-1', 'tool-1', 'FileWrite', '{}', 'running', NULL, '2026-05-01T00:00:00.000Z')`,
      ).run();
      expect(
        db
          .prepare<[], { recovery_category: string }>(
            "SELECT recovery_category FROM in_flight_tool_calls",
          )
          .get()?.recovery_category,
      ).toBe("side-effecting");
      expect(
        db
          .prepare<[], { version: number }>(
            "SELECT version FROM schema_migrations WHERE version = 10",
          )
          .get()?.version,
      ).toBe(10);
    } finally {
      db.close();
    }
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
