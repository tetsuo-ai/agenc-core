import { CSV_MAX_OUTPUT_STAGING_BYTES_GLOBAL } from "../../contracts/csv-job-contract.js";
import type { SqlMigration } from "./types.js";

export const CSV_OUTPUT_ORPHAN_ACCOUNTING_SCHEMA_VERSION = 26;

/**
 * Keep terminal output artifacts charged after their parent intent is moved
 * into tombstone evidence. Released ledger rows remain until the permanent
 * job tombstone owns their forensic record; only rows whose exact writer was
 * already proven gone may be reconciled automatically.
 */
export const csvOutputOrphanAccountingMigration: SqlMigration = {
  version: CSV_OUTPUT_ORPHAN_ACCOUNTING_SCHEMA_VERSION,
  name: "csv_output_orphan_accounting",
  apply(db) {
    const csvTables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('csv_output_intents', 'csv_storage_quota')`,
      )
      .all() as ReadonlyArray<{ readonly name: string }>;
    if (csvTables.length !== 2) return;
    const quotaColumns = db
      .prepare("PRAGMA table_info(csv_storage_quota)")
      .all() as ReadonlyArray<{ readonly name: string }>;
    const quotaNames = new Set(quotaColumns.map((column) => column.name));
    if (!quotaNames.has("output_orphan_files")) {
      db.exec(
        `ALTER TABLE csv_storage_quota
         ADD COLUMN output_orphan_files INTEGER NOT NULL DEFAULT 0
           CHECK (output_orphan_files >= 0)`,
      );
    }
    if (!quotaNames.has("output_orphan_bytes")) {
      db.exec(
        `ALTER TABLE csv_storage_quota
         ADD COLUMN output_orphan_bytes INTEGER NOT NULL DEFAULT 0
           CHECK (output_orphan_bytes >= 0)`,
      );
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS csv_output_orphans (
        intent_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        temporary_path TEXT NOT NULL,
        temporary_dev TEXT,
        temporary_ino TEXT,
        temporary_birthtime_ns TEXT,
        writer_anchor_state TEXT NOT NULL,
        target_anchor_state TEXT NOT NULL,
        target_original_dev TEXT,
        target_original_ino TEXT,
        target_original_size TEXT,
        target_original_mtime_ns TEXT,
        target_original_ctime_ns TEXT,
        target_original_sha256 TEXT,
        reserved_bytes INTEGER NOT NULL CHECK (
          reserved_bytes BETWEEN 0 AND ${CSV_MAX_OUTPUT_STAGING_BYTES_GLOBAL}
        ),
        terminal_kind TEXT NOT NULL CHECK (terminal_kind IN (
          'orphaned_unverifiable_writer_identity',
          'orphaned_target_replacement_conflict'
        )),
        diagnostic TEXT NOT NULL,
        cleanup_eligible INTEGER NOT NULL DEFAULT 0 CHECK (
          cleanup_eligible IN (0, 1)
        ),
        state TEXT NOT NULL DEFAULT 'retained' CHECK (
          state IN ('retained', 'released')
        ),
        released_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (state = 'retained' AND released_at IS NULL) OR
          (state = 'released' AND cleanup_eligible = 1 AND released_at IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_csv_output_orphans_root_state
      ON csv_output_orphans(root_path, state, cleanup_eligible, intent_id);

      CREATE INDEX IF NOT EXISTS idx_csv_output_orphans_job
      ON csv_output_orphans(job_id, intent_id);

      INSERT OR IGNORE INTO csv_output_orphans (
        intent_id, job_id, root_path, target_path, temporary_path,
        temporary_dev, temporary_ino, temporary_birthtime_ns,
        writer_anchor_state, target_anchor_state,
        target_original_dev, target_original_ino, target_original_size,
        target_original_mtime_ns, target_original_ctime_ns,
        target_original_sha256, reserved_bytes, terminal_kind, diagnostic,
        cleanup_eligible, state, released_at, created_at, updated_at
      )
      SELECT intent_id, job_id, root_path, target_path, temporary_path,
             temporary_dev, temporary_ino, temporary_birthtime_ns,
             writer_anchor_state, target_anchor_state,
             target_original_dev, target_original_ino, target_original_size,
             target_original_mtime_ns, target_original_ctime_ns,
             target_original_sha256, reserved_bytes, terminal_kind,
             COALESCE(last_error, 'legacy terminal CSV output evidence'),
             0, 'retained', NULL, created_at, updated_at
      FROM csv_output_intents
      WHERE terminal_kind IS NOT NULL AND quota_released = 1;
    `);
    // Preserve the actual charge even if an older binary already exceeded the
    // aggregate cap. New admission remains blocked until reconciliation brings
    // the durable total back below the limit.
    db.exec(`
      UPDATE csv_storage_quota SET
        output_staging_files = (
          SELECT COUNT(*) FROM csv_output_intents
          WHERE terminal_kind IS NULL AND quota_released = 0
        ),
        output_staging_bytes = (
          SELECT COALESCE(SUM(reserved_bytes), 0)
          FROM csv_output_intents
          WHERE terminal_kind IS NULL AND quota_released = 0
        ),
        output_orphan_files = (
          SELECT COUNT(*) FROM csv_output_orphans WHERE state = 'retained'
        ),
        output_orphan_bytes = (
          SELECT COALESCE(SUM(reserved_bytes), 0)
          FROM csv_output_orphans WHERE state = 'retained'
        )
      WHERE singleton = 1;
    `);
  },
};
