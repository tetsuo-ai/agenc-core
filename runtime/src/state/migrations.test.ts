import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LOGS_DB_MIGRATIONS,
  STATE_DB_MIGRATIONS,
  type SqlMigration,
} from "./migrations/index.js";

const migrationDir = dirname(fileURLToPath(import.meta.url));

describe("state migration registry", () => {
  it("loads state migrations from numbered migration files in order", () => {
    expect(STATE_DB_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(STATE_DB_MIGRATIONS.map((migration) => migration.name)).toEqual([
      "initial_state_schema",
      "csv_agent_jobs_schema",
      "agent_runs_schema",
      "session_state_snapshots_schema",
      "in_flight_tool_calls_schema",
    ]);
    expectMigrationVersionsAreUnique(STATE_DB_MIGRATIONS);
  });

  it("loads logs migrations from numbered migration files in order", () => {
    expect(LOGS_DB_MIGRATIONS.map((migration) => migration.version)).toEqual([1]);
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
    ]);
  });
});

function expectMigrationVersionsAreUnique(
  migrations: readonly SqlMigration[],
): void {
  const versions = migrations.map((migration) => migration.version);
  expect(new Set(versions).size).toBe(versions.length);
}
