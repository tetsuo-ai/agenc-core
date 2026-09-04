import type { SqlMigration } from "./types.js";

interface TableColumnRow {
  readonly name: string;
}

export const DROP_THREADS_LAST_ITEM_INDEX_SCHEMA_VERSION = 32;

/**
 * Drops the vestigial `threads.last_item_index` column.
 *
 * Nothing in the runtime reads or writes it. Incremental backfill tracks
 * freshness via `backfill_files` (size, mtime, line_count) instead (#2028).
 */
export const dropThreadsLastItemIndexMigration: SqlMigration = {
  version: DROP_THREADS_LAST_ITEM_INDEX_SCHEMA_VERSION,
  name: "drop_threads_last_item_index",
  apply: (db) => {
    if (!hasColumn(db, "threads", "last_item_index")) return;
    db.exec("ALTER TABLE threads DROP COLUMN last_item_index");
  },
};

function hasColumn(
  db: Parameters<NonNullable<SqlMigration["apply"]>>[0],
  table: string,
  column: string,
): boolean {
  return db
    .prepare<[], TableColumnRow>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}
