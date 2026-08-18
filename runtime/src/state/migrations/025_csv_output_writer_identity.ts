import type { SqlMigration } from "./types.js";

export const CSV_OUTPUT_WRITER_IDENTITY_SCHEMA_VERSION = 25;

/**
 * Persist optional birth-time diagnostics and a crash-recoverable hardlink
 * anchor phase. The anchor, not a timestamp of filesystem-dependent precision,
 * pins the exact writer inode and prevents device/inode ABA reuse. Existing
 * intents remain unanchored and cannot authorize destructive recovery.
 * Terminal metadata retains that evidence while making quota release and
 * recovery exclusion explicit and idempotent.
 */
export const csvOutputWriterIdentityMigration: SqlMigration = {
  version: CSV_OUTPUT_WRITER_IDENTITY_SCHEMA_VERSION,
  name: "csv_output_writer_identity",
  apply(db) {
    const table = db
      .prepare(
        `SELECT 1 AS present FROM sqlite_master
         WHERE type = 'table' AND name = 'csv_output_intents'`,
      )
      .get();
    if (table === undefined) return;
    const columns = db
      .prepare("PRAGMA table_info(csv_output_intents)")
      .all() as ReadonlyArray<{ readonly name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("temporary_birthtime_ns")) {
      db.exec(
        `ALTER TABLE csv_output_intents
         ADD COLUMN temporary_birthtime_ns TEXT`,
      );
    }
    if (!names.has("writer_anchor_state")) {
      db.exec(
        `ALTER TABLE csv_output_intents
         ADD COLUMN writer_anchor_state TEXT NOT NULL DEFAULT 'legacy'
           CHECK (writer_anchor_state IN ('legacy', 'pending', 'ready', 'releasing'))`,
      );
    }
    if (!names.has("quota_released")) {
      db.exec(
        `ALTER TABLE csv_output_intents
         ADD COLUMN quota_released INTEGER NOT NULL DEFAULT 0
           CHECK (quota_released IN (0, 1))`,
      );
    }
    if (!names.has("terminal_kind")) {
      db.exec(
        `ALTER TABLE csv_output_intents
         ADD COLUMN terminal_kind TEXT
           CHECK (
             terminal_kind IS NULL OR
             (
               terminal_kind IN (
                 'orphaned_unverifiable_writer_identity',
                 'orphaned_target_replacement_conflict'
               ) AND
               state = 'abandoned' AND quota_released = 1
             )
           )`,
      );
    }
    if (!names.has("target_anchor_state")) {
      db.exec(
        `ALTER TABLE csv_output_intents
         ADD COLUMN target_anchor_state TEXT NOT NULL DEFAULT 'legacy'
           CHECK (target_anchor_state IN (
             'legacy', 'absent', 'pending', 'ready', 'replacing', 'releasing'
           ))`,
      );
    }
    for (const column of [
      "target_original_dev",
      "target_original_ino",
      "target_original_size",
      "target_original_mtime_ns",
      "target_original_ctime_ns",
      "target_original_sha256",
    ]) {
      if (!names.has(column)) {
        db.exec(`ALTER TABLE csv_output_intents ADD COLUMN ${column} TEXT`);
      }
    }
    // Older job GC could cascade an active intent without releasing these
    // counters. Rebuild them from surviving active rows while migration owns
    // the database, so an already-stranded quota does not remain permanent.
    db.exec(`
      UPDATE csv_storage_quota SET
        output_staging_files = (
          SELECT COUNT(*) FROM csv_output_intents WHERE quota_released = 0
        ),
        output_staging_bytes = (
          SELECT COALESCE(SUM(reserved_bytes), 0)
          FROM csv_output_intents WHERE quota_released = 0
        )
      WHERE singleton = 1;
    `);
    db.exec(`
      DROP TRIGGER IF EXISTS csv_output_intents_terminal_insert_guard;
      DROP TRIGGER IF EXISTS csv_output_intents_terminal_update_guard;
      DROP TRIGGER IF EXISTS csv_agent_jobs_active_output_delete_guard;

      CREATE TRIGGER IF NOT EXISTS csv_output_intents_terminal_insert_guard
      BEFORE INSERT ON csv_output_intents
      WHEN
        (NEW.terminal_kind IS NULL AND NEW.quota_released <> 0) OR
        (
          NEW.terminal_kind IS NOT NULL AND NOT (
            NEW.terminal_kind IN (
              'orphaned_unverifiable_writer_identity',
              'orphaned_target_replacement_conflict'
            ) AND
            NEW.quota_released = 1 AND NEW.state = 'abandoned'
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid CSV output terminal quota state');
      END;

      CREATE TRIGGER IF NOT EXISTS csv_output_intents_terminal_update_guard
      BEFORE UPDATE OF terminal_kind, quota_released, state
      ON csv_output_intents
      WHEN
        (NEW.terminal_kind IS NULL AND NEW.quota_released <> 0) OR
        (
          NEW.terminal_kind IS NOT NULL AND NOT (
            NEW.terminal_kind IN (
              'orphaned_unverifiable_writer_identity',
              'orphaned_target_replacement_conflict'
            ) AND
            NEW.quota_released = 1 AND NEW.state = 'abandoned'
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid CSV output terminal quota state');
      END;

      CREATE TRIGGER IF NOT EXISTS csv_agent_jobs_active_output_delete_guard
      BEFORE DELETE ON csv_agent_jobs
      WHEN EXISTS (
        SELECT 1 FROM csv_output_intents
        WHERE job_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'CSV job has retained output intent evidence');
      END;

      CREATE TRIGGER IF NOT EXISTS csv_output_intents_single_job_guard
      BEFORE INSERT ON csv_output_intents
      WHEN EXISTS (
        SELECT 1 FROM csv_output_intents WHERE job_id = NEW.job_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'CSV job already has output intent evidence');
      END;

      CREATE TRIGGER IF NOT EXISTS csv_output_intents_anchor_phase_guard
      BEFORE UPDATE OF writer_anchor_state ON csv_output_intents
      WHEN NOT (
        (OLD.writer_anchor_state = 'legacy' AND NEW.writer_anchor_state = 'legacy') OR
        (
          OLD.writer_anchor_state = 'pending' AND
          NEW.writer_anchor_state IN ('pending', 'ready', 'releasing')
        ) OR
        (
          OLD.writer_anchor_state = 'ready' AND
          NEW.writer_anchor_state IN ('ready', 'releasing')
        ) OR
        (
          OLD.writer_anchor_state = 'releasing' AND
          NEW.writer_anchor_state = 'releasing'
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid CSV output writer anchor phase transition');
      END;

      CREATE TRIGGER IF NOT EXISTS csv_output_intents_target_phase_guard
      BEFORE UPDATE OF target_anchor_state ON csv_output_intents
      WHEN NOT (
        (OLD.target_anchor_state = 'legacy' AND NEW.target_anchor_state = 'legacy') OR
        (OLD.target_anchor_state = 'absent' AND NEW.target_anchor_state = 'absent') OR
        (
          OLD.target_anchor_state = 'pending' AND
          NEW.target_anchor_state IN ('pending', 'ready', 'releasing')
        ) OR
        (
          OLD.target_anchor_state = 'ready' AND
          NEW.target_anchor_state IN ('ready', 'replacing', 'releasing')
        ) OR
        (
          OLD.target_anchor_state = 'replacing' AND
          NEW.target_anchor_state IN ('replacing', 'releasing')
        ) OR
        (
          OLD.target_anchor_state = 'releasing' AND
          NEW.target_anchor_state = 'releasing'
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid CSV output target anchor phase transition');
      END;

      CREATE INDEX IF NOT EXISTS idx_csv_output_intents_job_quota
      ON csv_output_intents(job_id, quota_released);
    `);
  },
};
