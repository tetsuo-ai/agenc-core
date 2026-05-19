import type { SqlMigration } from "./types.js";

interface TableColumnRow {
  readonly name: string;
}

/**
 * Persist daemon background-agent runtime identity needed for restart restore.
 */
export const agentRunMetadataSchemaMigration: SqlMigration = {
  version: 9,
  name: "agent_run_metadata_schema",
  apply: (db) => {
    if (!hasAgentRunsTable(db)) return;
    if (!hasAgentRunsColumn(db, "metadata_json")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN metadata_json TEXT");
    }
  },
};

function hasAgentRunsTable(
  db: Parameters<NonNullable<SqlMigration["apply"]>>[0],
): boolean {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'",
    )
    .get() !== undefined;
}

function hasAgentRunsColumn(
  db: Parameters<NonNullable<SqlMigration["apply"]>>[0],
  column: string,
): boolean {
  return db
    .prepare<[], TableColumnRow>("PRAGMA table_info(agent_runs)")
    .all()
    .some((row) => row.name === column);
}
