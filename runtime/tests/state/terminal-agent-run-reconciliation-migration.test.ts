import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { STATE_DB_MIGRATIONS } from "../../src/state/migrations/index.js";
import { applyMigrations } from "../../src/state/sqlite-driver.js";

interface AgentRunRow {
  readonly status: string;
  readonly last_active_at: string;
}

describe("terminal agent-run reconciliation migration", () => {
  it("repairs only current-epoch terminals and preserves stronger projection state", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(
        db,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version <= 28),
      );
      db.exec(`
        INSERT INTO agent_runs (
          id, objective, status, started_at, last_active_at
        ) VALUES
          ('stale-current', 'current terminal', 'running', '2026-08-20T00:00:00.000Z', '2026-08-20T00:01:00.000Z'),
          ('reopened-current', 'reopened', 'running', '2026-08-20T00:00:00.000Z', '2026-08-20T00:02:00.000Z'),
          ('cancel-locked', 'cancelled', 'cancelled', '2026-08-20T00:00:00.000Z', '2026-08-20T00:03:00.000Z');

        INSERT INTO run_lifecycle_epochs (
          run_id, epoch, opened_at, opened_event_id,
          reopened_from_epoch, reopen_reason
        ) VALUES
          ('stale-current', 1, '2026-08-20T00:00:00.000Z', NULL, NULL, NULL),
          ('reopened-current', 1, '2026-08-20T00:00:00.000Z', NULL, NULL, NULL),
          ('reopened-current', 2, '2026-08-20T01:00:00.000Z', 'reopen-2', 1, 'operator'),
          ('cancel-locked', 1, '2026-08-20T00:00:00.000Z', NULL, NULL, NULL),
          ('child-without-rail', 1, '2026-08-20T00:00:00.000Z', NULL, NULL, NULL);

        INSERT INTO run_terminal_results (
          run_id, epoch, status, finished_at, event_id
        ) VALUES
          ('stale-current', 1, 'failed', '2026-08-20T00:30:00.000Z', 'terminal-stale'),
          ('reopened-current', 1, 'completed', '2026-08-20T00:30:00.000Z', 'terminal-old-epoch'),
          ('cancel-locked', 1, 'completed', '2026-08-20T00:30:00.000Z', 'terminal-cancelled'),
          ('child-without-rail', 1, 'completed', '2026-08-20T00:30:00.000Z', 'terminal-child');
      `);

      applyMigrations(db, STATE_DB_MIGRATIONS);
      applyMigrations(db, STATE_DB_MIGRATIONS);

      const row = (runId: string): AgentRunRow | undefined =>
        db
          .prepare<[string], AgentRunRow>(
            "SELECT status, last_active_at FROM agent_runs WHERE id = ?",
          )
          .get(runId);
      expect(row("stale-current")).toEqual({
        status: "failed",
        last_active_at: "2026-08-20T00:30:00.000Z",
      });
      expect(row("reopened-current")).toEqual({
        status: "running",
        last_active_at: "2026-08-20T00:02:00.000Z",
      });
      expect(row("cancel-locked")).toEqual({
        status: "cancelled",
        last_active_at: "2026-08-20T00:03:00.000Z",
      });
      expect(row("child-without-rail")).toBeUndefined();
      expect(
        db
          .prepare<[number], { readonly name: string }>(
            "SELECT name FROM schema_migrations WHERE version = ?",
          )
          .get(29),
      ).toEqual({ name: "terminal_agent_run_reconciliation" });
    } finally {
      db.close();
    }
  });
});
