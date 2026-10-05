import type { SqlMigration } from "./types.js";

const CANONICAL_PROJECTION_MARKER_SCHEMA_VERSION = 36;

const MARKER_COLUMNS = [
  ["canonical_epoch", "TEXT"],
  ["canonical_size", "INTEGER"],
  ["canonical_mtime_ms", "REAL"],
  ["canonical_sha256", "TEXT"],
  ["canonical_dev", "TEXT"],
  ["canonical_ino", "TEXT"],
] as const;

/**
 * Records which rollout projections the strict canonical path wrote.
 *
 * `backfill_files` is also written by the tolerant indexer, so its receipt
 * alone never proves that a journal passed canonical validation. These
 * columns are set only by canonical admission recovery, in the same
 * transaction as its projection and after the source fsync, and every other
 * receipt write clears them. Existing rows start without a marker, so the
 * first start after this migration validates every journal as before.
 */
export const canonicalProjectionMarkerMigration: SqlMigration = {
  version: CANONICAL_PROJECTION_MARKER_SCHEMA_VERSION,
  name: "canonical_projection_marker",
  apply(db) {
    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info(backfill_files)")
      .all();
    if (columns.length === 0) return;
    for (const [name, type] of MARKER_COLUMNS) {
      if (columns.some((column) => column.name === name)) continue;
      db.exec(`ALTER TABLE backfill_files ADD COLUMN ${name} ${type}`);
    }
  },
};
