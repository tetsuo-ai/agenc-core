import type { SqlMigration } from "./types.js";

export const THREAD_LISTING_INDEXES_SCHEMA_VERSION = 13;

/**
 * Index the bounded thread metadata pages used by daemon session.list.
 *
 * Separate partial indexes keep the archived predicate out of the scan and
 * preserve deterministic `(timestamp, thread_id)` ordering in either list
 * direction. SQLite can traverse each index forwards or backwards, so one
 * index per timestamp field and archive state covers both ASC and DESC.
 */
export const threadListingIndexesMigration: SqlMigration = {
  version: THREAD_LISTING_INDEXES_SCHEMA_VERSION,
  name: "thread_listing_indexes",
  apply: (db) => {
    const columns = db
      .prepare<[], { readonly name: string }>("PRAGMA table_info(threads)")
      .all();
    const names = new Set(columns.map((column) => column.name));
    // Migration tests intentionally exercise isolated legacy table fragments.
    // Record v13 as a no-op there; every real v1+ state database has this
    // complete threads projection.
    if (
      !names.has("thread_id") ||
      !names.has("created_at") ||
      !names.has("updated_at") ||
      !names.has("archived_at")
    ) {
      return;
    }
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_threads_active_created_listing
  ON threads(created_at, thread_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_threads_active_updated_listing
  ON threads(updated_at, thread_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_threads_archived_created_listing
  ON threads(created_at, thread_id)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_threads_archived_updated_listing
  ON threads(updated_at, thread_id)
  WHERE archived_at IS NOT NULL;
`);
  },
};
