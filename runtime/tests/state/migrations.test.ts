import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourcePath } from "../helpers/source-path.ts";
import Database from "better-sqlite3";
import {
  LOGS_DB_MIGRATIONS,
  STATE_DB_MIGRATIONS,
  type SqlMigration,
} from "./migrations/index.js";
import { applyMigrations } from "./sqlite-driver.js";
import { StateSchemaMismatchError } from "./errors.js";

const migrationDir = sourcePath("state");

describe("state migration registry", () => {
  it("rolls back a failed migration to a savepoint inside an outer transaction", () => {
    const db = new Database(":memory:");
    try {
      db.exec("BEGIN");
      expect(() =>
        applyMigrations(db, [
          {
            version: 1,
            name: "fails_after_ddl",
            apply: (migrationDb) => {
              migrationDb.exec(
                "CREATE TABLE partial_migration (id INTEGER PRIMARY KEY)",
              );
              migrationDb.exec("INSERT INTO partial_migration (id) VALUES (1)");
              throw new Error("forced migration failure");
            },
          },
        ]),
      ).toThrow(/state migration 1 failed/);
      db.exec("COMMIT");

      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_migration'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare("SELECT version FROM schema_migrations WHERE version = 1")
          .get(),
      ).toBeUndefined();
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
  });

  it("loads state migrations from numbered migration files in order", () => {
    expect(STATE_DB_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
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
      "memory_pipeline_schema",
      "agent_role_workspace_provenance",
      "thread_listing_indexes",
      "execution_admission_schema",
      "run_durability_schema",
      "run_effects_session_call_step_index",
    ]);
    expectMigrationVersionsAreUnique(STATE_DB_MIGRATIONS);
  });

  it("loads logs migrations from numbered migration files in order", () => {
    expect(LOGS_DB_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1,
    ]);
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
      "011_memory_pipeline_schema.ts",
      "012_agent_role_workspace_provenance.ts",
      "013_thread_listing_indexes.ts",
      "014_execution_admission_schema.ts",
      "015_run_durability_schema.ts",
      "016_run_effects_session_call_step_index.ts",
    ]);
  });

  it("adds durable run state without copying canonical rollout event payloads", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db, STATE_DB_MIGRATIONS);
      applyMigrations(db, STATE_DB_MIGRATIONS);

      const tables = db
        .prepare<[], { name: string }>(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'run_%'
           ORDER BY name ASC`,
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual([
        "run_effects",
        "run_journal_bindings",
        "run_lifecycle_epochs",
        "run_terminal_results",
      ]);
      expect(tables).not.toContain("run_journal_events");
      expect(
        db
          .prepare<[], { version: number; name: string }>(
            "SELECT version, name FROM schema_migrations WHERE version = 15",
          )
          .get(),
      ).toEqual({ version: 15, name: "run_durability_schema" });
      expect(
        db
          .prepare<[], { version: number; name: string }>(
            "SELECT version, name FROM schema_migrations WHERE version = 16",
          )
          .get(),
      ).toEqual({ version: 16, name: "run_effects_session_call_step_index" });

      const effectIndexes = db
        .prepare<[], { name: string }>("PRAGMA index_list(run_effects)")
        .all()
        .map((row) => row.name);
      expect(effectIndexes).toEqual(
        expect.arrayContaining([
          "idx_run_effects_intent_sequence",
          "idx_run_effects_result_sequence",
          "idx_run_effects_pending_review",
          "idx_run_effects_session_call_step",
        ]),
      );
      // The old per-(session, call) uniqueness is gone: legitimate physical
      // re-dispatches of one logical call register one row per step.
      expect(effectIndexes).not.toContain("idx_run_effects_session_call");
      const journalIndexes = db
        .prepare<[], { name: string }>(
          "PRAGMA index_list(run_journal_bindings)",
        )
        .all()
        .map((row) => row.name);
      expect(journalIndexes).toContain("idx_run_journal_bindings_active");
      const rolloutIndexes = db
        .prepare<[], { name: string }>(
          "PRAGMA index_list(thread_rollout_items)",
        )
        .all()
        .map((row) => row.name);
      expect(rolloutIndexes).toEqual(
        expect.arrayContaining([
          "idx_thread_rollout_items_replay_source_sequence",
          "idx_thread_rollout_items_replay_thread_sequence",
          "idx_thread_rollout_items_replay_source_identity",
          "idx_thread_rollout_items_replay_thread_identity",
        ]),
      );
      const sequencePlan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT event_seq, event_id, payload_json
           FROM thread_rollout_items
           WHERE source_path = ? AND item_type = 'event_msg'
             AND event_seq > ?
           GROUP BY event_seq, event_id, payload_json
           ORDER BY event_seq
           LIMIT ?`,
        )
        .all("/rollout/run.jsonl", 0, 201)
        .map((row) => String((row as { detail?: unknown }).detail ?? ""));
      expect(sequencePlan.join("\n")).toContain(
        "idx_thread_rollout_items_replay_source_sequence",
      );
      const identityPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT event_id, event_seq, payload_json
           FROM thread_rollout_items
           WHERE source_path = ? AND item_type = 'event_msg'
             AND event_seq IS NOT NULL AND event_id IN (?, ?)
           GROUP BY event_id, event_seq, payload_json`,
        )
        .all("/rollout/run.jsonl", "event:1", "event:2")
        .map((row) => String((row as { detail?: unknown }).detail ?? ""));
      expect(identityPlan.join("\n")).toContain(
        "idx_thread_rollout_items_replay_source_identity",
      );
    } finally {
      db.close();
    }
  });

  it("installs ordering indexes for bounded active and archived thread pages", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db, STATE_DB_MIGRATIONS);
      const indexes = db
        .prepare("PRAGMA index_list(threads)")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "idx_threads_active_created_listing",
          "idx_threads_active_updated_listing",
          "idx_threads_archived_created_listing",
          "idx_threads_archived_updated_listing",
        ]),
      );
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT thread_id, created_at
           FROM threads
           WHERE archived_at IS NULL
             AND (created_at, thread_id) < (?, ?)
           ORDER BY created_at DESC, thread_id DESC
           LIMIT ?`,
        )
        .all("2026-01-01", "cursor", 51)
        .map((row) => String((row as { detail?: unknown }).detail ?? ""));
      expect(plan.join("\n")).toContain(
        "SEARCH threads USING INDEX idx_threads_active_created_listing",
      );
    } finally {
      db.close();
    }
  });

  it("backfills durable role-workspace provenance idempotently", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(
        db,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version < 12),
      );
      db.prepare(
        `INSERT INTO thread_spawn_edges (
          child_thread_id, parent_thread_id, parent_path, metadata_json, status
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "child-1",
        "root-1",
        "/root",
        JSON.stringify({
          agentId: "child-1",
          agentPath: "/root/child",
          agentRole: "reviewer",
          agentRoleWorkspaceId: "/workspace/a",
          agentRoleFingerprint: "reviewer-fingerprint",
          depth: 1,
        }),
        "open",
      );
      db.prepare(
        `INSERT INTO thread_spawn_edges (
          child_thread_id, parent_thread_id, parent_path, metadata_json, status
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "legacy-named-child",
        "root-1",
        "/root",
        JSON.stringify({
          agentId: "legacy-named-child",
          agentPath: "/root/legacy-named-child",
          agentRole: "reviewer",
          depth: 1,
        }),
        "open",
      );

      applyMigrations(db, STATE_DB_MIGRATIONS);
      applyMigrations(db, STATE_DB_MIGRATIONS);

      expect(
        db
          .prepare(
            `SELECT agent_role_workspace_id, agent_role_fingerprint
             FROM thread_spawn_edges
             WHERE child_thread_id = ?`,
          )
          .get("child-1"),
      ).toEqual({
        agent_role_workspace_id: "/workspace/a",
        agent_role_fingerprint: "reviewer-fingerprint",
      });
      expect(() =>
        db
          .prepare(
            `UPDATE thread_spawn_edges
             SET metadata_json = ?
             WHERE child_thread_id = ?`,
          )
          .run(
            JSON.stringify({
              agentId: "child-1",
              agentPath: "/root/child",
              agentRole: "default",
              depth: 1,
            }),
            "child-1",
          ),
      ).toThrow(/identity is immutable/);
      expect(() =>
        db
          .prepare(
            `UPDATE thread_spawn_edges
             SET metadata_json = ?
             WHERE child_thread_id = ?`,
          )
          .run(
            JSON.stringify({
              agentId: "legacy-named-child",
              agentPath: "/root/legacy-named-child",
              agentRole: "reviewer",
              agentRoleWorkspaceId: "/workspace/injected",
              agentRoleFingerprint: "injected-fingerprint",
              depth: 1,
            }),
            "legacy-named-child",
          ),
      ).toThrow(/identity is immutable/);
      expect(
        db
          .prepare("SELECT version FROM schema_migrations WHERE version = 12")
          .get(),
      ).toEqual({ version: 12 });
      expect(() =>
        applyMigrations(db, STATE_DB_MIGRATIONS.slice(0, -1)),
      ).toThrow(StateSchemaMismatchError);
    } finally {
      db.close();
    }
  });

  it("adds memory pipeline schema to legacy memory job tables idempotently", () => {
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
          (9, 'agent_run_metadata_schema'),
          (10, 'tool_recovery_category_schema');
        CREATE TABLE memory_jobs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          input_json TEXT NOT NULL,
          result_json TEXT,
          error TEXT,
          worker_id TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          available_at TEXT NOT NULL
        );
        INSERT INTO memory_jobs (
          id, kind, status, priority, input_json, attempts, created_at, updated_at, available_at
        ) VALUES ('legacy-1', 'extract', 'queued', 0, '{}', 0, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z');
      `);

      applyMigrations(db, STATE_DB_MIGRATIONS);
      applyMigrations(db, STATE_DB_MIGRATIONS);

      const memoryJobColumns = db
        .prepare<[], { name: string }>("PRAGMA table_info(memory_jobs)")
        .all()
        .map((row) => row.name);
      expect(memoryJobColumns).toContain("job_key");
      expect(memoryJobColumns).toContain("last_success_watermark");
      expect(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage1_outputs'",
          )
          .get()?.name,
      ).toBe("stage1_outputs");
      expect(
        db
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM memory_jobs WHERE id = 'legacy-1' AND job_key IS NULL",
          )
          .get()?.count,
      ).toBe(1);
      expect(
        db
          .prepare<[], { version: number }>(
            "SELECT version FROM schema_migrations WHERE version = 11",
          )
          .get()?.version,
      ).toBe(11);
    } finally {
      db.close();
    }
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
        .prepare<[], { name: string }>(
          "PRAGMA table_info(in_flight_tool_calls)",
        )
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
