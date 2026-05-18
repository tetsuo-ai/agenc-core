import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStateDatabases } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let originalAgencHome = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-state-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-state-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = home;
});

afterEach(() => {
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("openStateDatabases", () => {
  it("creates project-scoped state and logs databases with migrations", () => {
    const driver = openStateDatabases({ cwd });
    try {
      expect(driver.stateDbPath).toContain("agenc-state_1.sqlite");
      expect(driver.logsDbPath).toContain("agenc-logs_1.sqlite");
      expect(
        driver
          .prepareState<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
          )
          .get()?.name,
      ).toBe("threads");
      const agentRunColumns = driver
        .prepareState<[], { name: string }>("PRAGMA table_info(agent_runs)")
        .all()
        .map((column) => column.name);
      expect(agentRunColumns).toEqual([
        "id",
        "objective",
        "status",
        "started_at",
        "last_active_at",
        "current_session_id",
        "created_by_client",
        "last_snapshot_at",
      ]);
      const snapshotColumns = driver
        .prepareState<[], { name: string; notnull: number; pk: number }>(
          "PRAGMA table_info(session_state_snapshots)",
        )
        .all();
      expect(snapshotColumns.map((column) => column.name)).toEqual([
        "session_id",
        "snapshot_at",
        "conversation_json",
        "tool_state_json",
        "mcp_connection_state_json",
      ]);
      expect(snapshotColumns.find((column) => column.name === "session_id"))
        .toMatchObject({ notnull: 1, pk: 1 });
      expect(snapshotColumns.find((column) => column.name === "snapshot_at"))
        .toMatchObject({ notnull: 1, pk: 2 });
      const toolCallColumns = driver
        .prepareState<[], { name: string; notnull: number; pk: number }>(
          "PRAGMA table_info(in_flight_tool_calls)",
        )
        .all();
      expect(toolCallColumns.map((column) => column.name)).toEqual([
        "session_id",
        "tool_call_id",
        "tool_name",
        "args_json",
        "status",
        "output_partial",
        "started_at",
        "output_log_path",
        "output_log_bytes",
        "recovery_category",
      ]);
      expect(toolCallColumns.find((column) => column.name === "session_id"))
        .toMatchObject({ notnull: 1, pk: 1 });
      expect(toolCallColumns.find((column) => column.name === "tool_call_id"))
        .toMatchObject({ notnull: 1, pk: 2 });
      expect(
        driver
          .prepareLogs<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logs'",
          )
          .get()?.name,
      ).toBe("logs");
    } finally {
      driver.close();
    }
  });
});
