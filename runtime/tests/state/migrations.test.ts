import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeRootPath, sourcePath } from "../helpers/source-path.ts";
import Database from "better-sqlite3";
import {
  LOGS_DB_MIGRATIONS,
  STATE_DB_MIGRATIONS,
  type SqlMigration,
} from "./migrations/index.js";
import { TOOL_PAIR_PROJECTION_SCHEMA_VERSION } from "./migrations/020_tool_pair_projection_schema.js";
import { setBasedCancellationIndexesMigration } from "./migrations/023_set_based_cancellation_indexes.js";
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
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      20, 21, 22, 23, 24,
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
      "effect_evidence_v2",
      "run_recovery_schema",
      "csv_job_identity_replay",
      "tool_pair_projection_schema",
      "csv_job_scheduler",
      "workflow_handoff_artifacts",
      "set_based_cancellation_indexes",
      "compaction_transaction",
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
      "017_effect_evidence_v2.ts",
      "018_run_recovery_schema.ts",
      "019_csv_job_identity_replay.ts",
      "020_tool_pair_projection_schema.ts",
      "021_csv_job_scheduler.ts",
      "022_workflow_handoff_artifacts.ts",
      "023_set_based_cancellation_indexes.ts",
      "024_compaction_transaction.ts",
    ]);
  });

  it("adds compaction authority at v24 idempotently with immutable identity", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(
        db,
        STATE_DB_MIGRATIONS.filter(
          (migration) =>
            migration.version <= setBasedCancellationIndexesMigration.version,
        ),
      );
      expect(
        db.prepare(
          "SELECT version, name FROM schema_migrations WHERE version = ?",
        ).get(setBasedCancellationIndexesMigration.version),
      ).toEqual({
        version: setBasedCancellationIndexesMigration.version,
        name: setBasedCancellationIndexesMigration.name,
      });
      expect(
        db.prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'compaction_retention_pins'`,
        ).get(),
      ).toBeUndefined();

      applyMigrations(db, STATE_DB_MIGRATIONS);
      applyMigrations(db, STATE_DB_MIGRATIONS);
      expect(
        db.prepare(
          "SELECT version, name FROM schema_migrations WHERE version = 24",
        ).get(),
      ).toEqual({ version: 24, name: "compaction_transaction" });
      expect(
        db.prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'compaction_%'
           ORDER BY name`,
        ).all().map((row) => (row as { name: string }).name),
      ).toEqual([
        "compaction_failure_guards",
        "compaction_reconciliation_cursors",
        "compaction_recovery_deferrals",
        "compaction_retention_pins",
        "compaction_retention_references",
      ]);
      db.prepare(
        `INSERT INTO compaction_retention_pins (
           attempt_id, format_version, session_id, epoch, source_binding,
           first_sequence, last_sequence, source_sha256, source_bytes,
           history_digest, source_manifest_json, selected_history_indexes_json,
           policy_digest, configuration_digest, accounting_ref, automatic,
           admission_required, planned_provider_calls, state,
           reference_count, created_at_ms, cleanup_state, projection_state,
           prune_cursor
         ) VALUES (
           'attempt', 1, 'session', 1, 'binding', 1, 1, ?, 1, ?, '[{}]', '[0]',
           ?, ?, ?, 0, 1, 1, 'preparing', 0, 0, 'not_started', 'not_committed', 0
         )`,
      ).run(...Array(5).fill("a".repeat(64)));
      expect(() =>
        db.prepare(
          "UPDATE compaction_retention_pins SET source_binding = 'other' WHERE attempt_id = 'attempt'",
        ).run(),
      ).toThrow(/identity is immutable/i);
      db.prepare(
        `INSERT INTO compaction_reconciliation_cursors (
           cursor_name, created_at_ms, attempt_id, updated_at_ms
         ) VALUES ('session', 0, '', 0)`,
      ).run();
      expect(() =>
        db.prepare(
          `UPDATE compaction_reconciliation_cursors
           SET created_at_ms = -1 WHERE cursor_name = 'session'`,
        ).run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("adds workflow handoffs at v22 without changing legacy tool-output state", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(
        db,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version <= 21),
      );
      const legacyColumns = db
        .prepare<[], { readonly name: string; readonly type: string }>(
          "PRAGMA table_info(in_flight_tool_calls)",
        )
        .all();

      applyMigrations(db, STATE_DB_MIGRATIONS);

      expect(
        db
          .prepare<[], { readonly name: string; readonly type: string }>(
            "PRAGMA table_info(in_flight_tool_calls)",
          )
          .all(),
      ).toEqual(legacyColumns);
      expect(
        db
          .prepare<[], { readonly version: number; readonly name: string }>(
            "SELECT version, name FROM schema_migrations WHERE version = 22",
          )
          .get(),
      ).toEqual({ version: 22, name: "workflow_handoff_artifacts" });
      const artifactColumns = db
        .prepare<[], { readonly name: string }>(
          "PRAGMA table_info(workflow_handoff_artifacts)",
        )
        .all()
        .map((row) => row.name);
      expect(artifactColumns).toContain("compatibility_epoch");
      expect(artifactColumns).not.toContain("minimum_reader_runtime");
      expect(
        db
          .prepare<[], { readonly name: string }>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'workflow_handoff_%'
             ORDER BY name`,
          )
          .all()
          .map((row) => row.name),
      ).toEqual([
        "workflow_handoff_artifacts",
        "workflow_handoff_cursors",
        "workflow_handoff_quota_global",
        "workflow_handoff_quota_runs",
        "workflow_handoff_references",
        "workflow_handoff_sequence",
      ]);
      expect(() =>
        db
          .prepare(
            `INSERT INTO workflow_handoff_artifacts (
               artifact_id, format_version, kind, compatibility_epoch,
               idempotency_key, run_id, workflow_id, producer_step_id,
               digest, byte_length, token_count, storage_ref, status, preview,
               preview_truncated, created_at_ms, last_access_at_ms,
               unreferenced_at_ms
             ) VALUES (
               'wh_000000000000000000000000000000000000000000000001', 1,
               'future_kind', 'workflow_handoff.v1/state-schema.22',
               'key', 'run', 'workflow', 'step',
               'sha256:0000000000000000000000000000000000000000000000000000000000000000',
               0, 0,
               'workflow-handoff:wh_000000000000000000000000000000000000000000000001',
               'intent', '', 0, 1, 1, 1
             )`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("upgrades persisted effect-evidence v17 state to recovery schema v18 additively", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(
        db,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version <= 17),
      );
      db.exec(`
        INSERT INTO run_lifecycle_epochs (run_id, epoch, opened_at)
        VALUES ('v17-run', 1, '2026-08-01T00:00:00.000Z');
        INSERT INTO run_journal_bindings (
          run_id, epoch, child_run_id, session_id, source_path, active,
          first_available_sequence, last_sequence, bound_at, updated_at
        ) VALUES (
          'v17-run', 1, 'v17-run', 'v17-session', '/rollouts/v17.jsonl', 1,
          1, 3, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        );
      `);

      applyMigrations(db, STATE_DB_MIGRATIONS);

      expect(
        db
          .prepare(
            `SELECT run_id, first_available_sequence, last_sequence,
                    authoritative_source_sha256, journal_format,
                    minimum_reader_runtime
             FROM run_journal_bindings
             WHERE source_path = '/rollouts/v17.jsonl'`,
          )
          .get(),
      ).toEqual({
        run_id: "v17-run",
        first_available_sequence: 1,
        last_sequence: 3,
        authoritative_source_sha256: null,
        journal_format: null,
        minimum_reader_runtime: null,
      });
      expect(
        db
          .prepare(
            "SELECT version, name FROM schema_migrations WHERE version = 18",
          )
          .get(),
      ).toEqual({ version: 18, name: "run_recovery_schema" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_recovery_quarantine'",
          )
          .get(),
      ).toEqual({ name: "run_recovery_quarantine" });
    } finally {
      db.close();
    }
  });

  it("upgrades persisted v18 state to the reserved tool-pair schema v20 additively", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(
        db,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version <= 18),
      );
      db.prepare(
        `INSERT INTO run_lifecycle_epochs (run_id, epoch, opened_at)
         VALUES ('pre-tool-pair-run', 1, '2026-08-01T00:00:00.000Z')`,
      ).run();
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_pair_projection_runs'",
          )
          .get(),
      ).toBeUndefined();

      applyMigrations(db, STATE_DB_MIGRATIONS);
      applyMigrations(db, STATE_DB_MIGRATIONS);

      expect(
        db
          .prepare(
            "SELECT run_id, epoch FROM run_lifecycle_epochs WHERE run_id = 'pre-tool-pair-run'",
          )
          .get(),
      ).toEqual({ run_id: "pre-tool-pair-run", epoch: 1 });
      expect(
        db
          .prepare(
            "SELECT version, name FROM schema_migrations WHERE version = ?",
          )
          .get(TOOL_PAIR_PROJECTION_SCHEMA_VERSION),
      ).toEqual({
        version: TOOL_PAIR_PROJECTION_SCHEMA_VERSION,
        name: "tool_pair_projection_schema",
      });
      expect(
        db
          .prepare<{ type: string }, { name: string }>(
            `SELECT name FROM sqlite_master
             WHERE type = :type AND name LIKE 'tool_pair_projection_%'
             ORDER BY name`,
          )
          .all({ type: "table" })
          .map((row) => row.name),
      ).toEqual(["tool_pair_projection_entries", "tool_pair_projection_runs"]);
    } finally {
      db.close();
    }
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
        "run_recovery_abandonments",
        "run_recovery_deferred",
        "run_recovery_quarantine",
        "run_recovery_quarantine_observations",
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
      expect(
        db
          .prepare<[], { version: number; name: string }>(
            "SELECT version, name FROM schema_migrations WHERE version = 17",
          )
          .get(),
      ).toEqual({ version: 17, name: "effect_evidence_v2" });
      expect(
        db
          .prepare<[], { version: number; name: string }>(
            "SELECT version, name FROM schema_migrations WHERE version = 18",
          )
          .get(),
      ).toEqual({ version: 18, name: "run_recovery_schema" });

      const journalColumnRows = db
        .prepare<[], { name: string; type: string }>(
          "PRAGMA table_info(run_journal_bindings)",
        )
        .all();
      const journalColumns = journalColumnRows.map((row) => row.name);
      expect(journalColumns).toEqual(
        expect.arrayContaining([
          "authoritative_source_sha256",
          "authoritative_source_size_bytes",
          "authoritative_source_mtime_ms",
          "journal_format",
          "minimum_reader_runtime",
        ]),
      );
      expect(
        journalColumnRows.find(
          (row) => row.name === "authoritative_source_mtime_ms",
        )?.type,
      ).toBe("REAL");
      const quarantineColumnRows = db
        .prepare<[], { name: string; type: string }>(
          "PRAGMA table_info(run_recovery_quarantine)",
        )
        .all();
      const quarantineColumns = quarantineColumnRows.map((row) => row.name);
      expect(quarantineColumns).toEqual(
        expect.arrayContaining([
          "source_sha256",
          "confirmed_source_sha256",
          "state",
          "resolved_at_ms",
        ]),
      );
      expect(
        quarantineColumnRows.find((row) => row.name === "source_mtime_ms")
          ?.type,
      ).toBe("REAL");

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

  it("migrates ambiguous v1 outcomes and reviews fail closed", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db, STATE_DB_MIGRATIONS.slice(0, 16));
      db.prepare(
        `INSERT INTO run_lifecycle_epochs (run_id, epoch, opened_at)
         VALUES ('legacy-run', 1, '2026-07-18T00:00:00.000Z')`,
      ).run();
      const insert = db.prepare(
        `INSERT INTO run_effects (
           run_id, step_id, epoch, session_id, call_id, tool_name,
           recovery_category, idempotency_key, intent_digest,
           intent_event_id, intent_sequence, intent_at, outcome,
           result_event_id, result_sequence, completed_at, review_status,
           unknown_reason, reviewed_at, reviewed_by, review_resolution,
           review_event_id
         ) VALUES (
           'legacy-run', ?, 1, 'legacy-session', ?, 'legacy-tool',
           ?, ?, 'intent-digest', ?, ?, '2026-07-18T00:00:00.000Z', ?,
           ?, ?, '2026-07-18T00:00:01.000Z', ?, ?, ?, ?, ?, ?
         )`,
      );
      insert.run(
        "side-failed",
        "call-side",
        "side-effecting",
        null,
        "intent-side",
        1,
        "failed",
        "result-side",
        2,
        "none",
        null,
        null,
        null,
        null,
        null,
      );
      insert.run(
        "idempotent-failed",
        "call-idempotent",
        "idempotent",
        "stable-key",
        "intent-idempotent",
        3,
        "failed",
        "result-idempotent",
        4,
        "none",
        null,
        null,
        null,
        null,
        null,
      );
      insert.run(
        "legacy-reviewed",
        "call-reviewed",
        "side-effecting",
        null,
        "intent-reviewed",
        5,
        "unknown_outcome",
        "result-reviewed",
        6,
        "resolved",
        "ack_lost",
        "2026-07-18T00:00:02.000Z",
        "legacy-operator",
        "human_verified",
        "legacy-review-event",
      );

      applyMigrations(db, STATE_DB_MIGRATIONS);

      const rows = db
        .prepare<
          [],
          {
            step_id: string;
            effect_format_version: number;
            outcome: string;
            effect_boundary: string | null;
            unknown_reason: string | null;
            review_status: string | null;
            review_disposition: string | null;
            legacy_review_json: string | null;
          }
        >(
          `SELECT step_id, effect_format_version, outcome, effect_boundary,
                  unknown_reason, review_status, review_disposition,
                  legacy_review_json
           FROM run_effects ORDER BY intent_sequence`,
        )
        .all();
      expect(rows[0]).toMatchObject({
        step_id: "side-failed",
        effect_format_version: 1,
        outcome: "unknown_outcome",
        effect_boundary: null,
        unknown_reason: "legacy_ambiguous_terminal_evidence",
        review_status: "pending",
      });
      expect(rows[1]).toMatchObject({
        step_id: "idempotent-failed",
        outcome: "failed",
        effect_boundary: "crossed",
        review_status: null,
      });
      expect(rows[2]).toMatchObject({
        step_id: "legacy-reviewed",
        outcome: "unknown_outcome",
        review_status: "pending",
        review_disposition: null,
      });
      expect(rows[2]?.legacy_review_json).toContain("human_verified");
    } finally {
      db.close();
    }
  });

  it("migrates legacy CSV running rows to non-executable review state", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db, STATE_DB_MIGRATIONS.slice(0, 16));
      const recipe = JSON.parse(
        readFileSync(
          join(
            runtimeRootPath,
            "tests/fnd/fixtures/csv/legacy-v2-on-state-v16.sqlite-seed.json",
          ),
          "utf8",
        ),
      ) as {
        readonly statements: ReadonlyArray<{
          readonly sql: string;
          readonly params: ReadonlyArray<unknown>;
        }>;
      };
      for (const statement of recipe.statements) {
        db.prepare(statement.sql).run(...statement.params);
      }
      db.prepare(
        `INSERT INTO csv_agent_jobs (
           id, name, status, instruction, output_schema_json,
           input_headers_json, input_csv_path, output_csv_path, auto_export,
           max_runtime_seconds, created_at, updated_at, started_at,
           completed_at, last_error
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, NULL, ?, ?, ?, ?, NULL)`,
      ).run(
        "legacy-completed-without-result",
        "legacy missing result",
        "completed",
        "process",
        '["value"]',
        "/input.csv",
        "",
        1,
        2,
        1,
        2,
      );
      db.prepare(
        `INSERT INTO csv_agent_job_items (
           job_id, item_id, row_index, source_id, row_json, status,
           assigned_thread_id, attempt_count, result_json, last_error,
           created_at, updated_at, completed_at, reported_at
         ) VALUES (?, ?, 0, NULL, ?, 'completed', NULL, 1, NULL, NULL,
                   1, 2, 2, 2)`,
      ).run(
        "legacy-completed-without-result",
        "legacy-source-identity",
        '{"value":"x"}',
      );

      applyMigrations(db, STATE_DB_MIGRATIONS);

      expect(
        db
          .prepare(
            `SELECT status, id_column, import_state, identity_format_version,
                    unknown_outcome_items, output_mode
             FROM csv_agent_jobs WHERE id = 'legacy-csv-v2'`,
          )
          .get(),
      ).toEqual({
        status: "running",
        id_column: null,
        import_state: "visible",
        identity_format_version: 0,
        unknown_outcome_items: 1,
        output_mode: "replace_existing_regular",
      });
      const migratedItems = db
        .prepare(
          `SELECT item_id, source_id, status, dispatch_state, review_status,
                  review_reason, worker_name, result_digest
           FROM csv_agent_job_items
           WHERE job_id = 'legacy-csv-v2'
           ORDER BY row_index`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(migratedItems).toEqual([
        expect.objectContaining({
          source_id: "pending-row",
          status: "pending",
          dispatch_state: "not_dispatched",
          review_status: null,
          review_reason: null,
        }),
        expect.objectContaining({
          source_id: "running-row",
          status: "unknown_outcome",
          dispatch_state: "ambiguous",
          review_status: "pending",
          review_reason: "legacy_csv_ambiguous",
        }),
        expect.objectContaining({
          source_id: "completed-row",
          status: "completed",
          dispatch_state: "settled",
          review_status: null,
          review_reason: null,
        }),
      ]);
      for (const [rowIndex, migrated] of migratedItems.entries()) {
        expect(migrated.item_id).toMatch(/^csv_item_[0-9a-f]{64}$/u);
        expect(migrated.worker_name).toMatch(
          new RegExp(`^csv_row_${rowIndex}_[0-9a-f]{16}$`, "u"),
        );
        expect(migrated.item_id).not.toBe(migrated.source_id);
      }
      expect(migratedItems[2]?.result_digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(
        db
          .prepare(
            `SELECT job.status AS job_status, item.status AS item_status,
                    item.result_availability, item.last_error
             FROM csv_agent_jobs AS job
             JOIN csv_agent_job_items AS item ON item.job_id = job.id
             WHERE job.id = 'legacy-completed-without-result'`,
          )
          .get(),
      ).toEqual({
        job_status: "failed",
        item_status: "failed",
        result_availability: "not_produced",
        last_error: "legacy_csv_completed_without_result",
      });
      expect(() =>
        db
          .prepare(
            "UPDATE csv_agent_jobs SET status = 'unknown_outcome' WHERE id = 'legacy-csv-v2'",
          )
          .run(),
      ).toThrow();
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
