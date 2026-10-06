import type { SqlMigration } from "./types.js";

/** Identifies an unarchive cleanup independently of its reused archive path. */
export const threadArchiveCleanupGenerationMigration: SqlMigration = {
  version: 34,
  name: "thread_archive_cleanup_generation",
  apply(db) {
    const columns = db.prepare<[], { name: string }>("PRAGMA table_info(threads)").all();
    if (columns.length > 0 && !columns.some((column) => column.name === "archive_cleanup_generation")) {
      db.exec("ALTER TABLE threads ADD COLUMN archive_cleanup_generation TEXT");
    }
  },
};
