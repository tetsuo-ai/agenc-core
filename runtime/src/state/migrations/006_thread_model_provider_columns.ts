import type { SqlMigration } from "./types.js";

interface TableColumnRow {
  readonly name: string;
}

/**
 * Repairs state databases created by early ST-11 prototypes whose
 * `threads` table did not yet include model/provider metadata columns.
 */
export const threadModelProviderColumnsMigration: SqlMigration = {
  version: 6,
  name: "thread_model_provider_columns",
  apply: (db) => {
    if (!hasColumn(db, "threads", "model")) {
      db.exec("ALTER TABLE threads ADD COLUMN model TEXT");
    }
    if (!hasColumn(db, "threads", "model_provider")) {
      db.exec("ALTER TABLE threads ADD COLUMN model_provider TEXT");
    }
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
