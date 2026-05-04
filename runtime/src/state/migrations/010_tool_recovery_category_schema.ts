import type { SqlMigration } from "./types.js";

interface TableColumnRow {
  readonly name: string;
}

/**
 * Persist the restart recovery category captured at tool registration time.
 */
export const toolRecoveryCategorySchemaMigration: SqlMigration = {
  version: 10,
  name: "tool_recovery_category_schema",
  apply: (db) => {
    if (!hasInFlightToolCallsTable(db)) return;
    if (!hasInFlightToolCallsColumn(db, "recovery_category")) {
      db.exec(
        "ALTER TABLE in_flight_tool_calls ADD COLUMN recovery_category TEXT NOT NULL DEFAULT 'side-effecting'",
      );
    }
  },
};

function hasInFlightToolCallsTable(
  db: Parameters<NonNullable<SqlMigration["apply"]>>[0],
): boolean {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'in_flight_tool_calls'",
    )
    .get() !== undefined;
}

function hasInFlightToolCallsColumn(
  db: Parameters<NonNullable<SqlMigration["apply"]>>[0],
  column: string,
): boolean {
  return db
    .prepare<[], TableColumnRow>("PRAGMA table_info(in_flight_tool_calls)")
    .all()
    .some((row) => row.name === column);
}
