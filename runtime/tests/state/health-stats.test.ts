import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateSqliteHealthStatsReader } from "./health-stats.js";
import {
  openStateDatabases,
  resolveStateDatabasePaths,
  type StateSqliteDriver,
} from "./sqlite-driver.js";

let home = "";
let cwd = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-health-state-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-health-state-cwd-"));
  mkdirSync(join(cwd, ".git"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("StateSqliteHealthStatsReader", () => {
  it("reports unavailable zero counts before the daemon initializes state", () => {
    const paths = resolveStateDatabasePaths({ cwd, agencHome: home });
    const reader = new StateSqliteHealthStatsReader(paths);

    expect(reader.readStateStats()).toEqual({
      available: false,
      readonly: true,
      projectDir: paths.projectDir,
      agentRuns: 0,
      sessionStateSnapshots: 0,
      inFlightToolCalls: 0,
      logs: 0,
    });
  });

  it("counts state and log rows through read-only handles", () => {
    const writer = openStateDatabases({ cwd, agencHome: home });
    try {
      seedStateRows(writer);
      const paths = resolveStateDatabasePaths({ cwd, agencHome: home });
      const reader = new StateSqliteHealthStatsReader(paths);

      expect(reader.readStateStats()).toEqual({
        available: true,
        readonly: true,
        projectDir: paths.projectDir,
        agentRuns: 1,
        sessionStateSnapshots: 1,
        inFlightToolCalls: 1,
        logs: 1,
      });
    } finally {
      writer.close();
    }
  });

  it("aggregates counts across multiple state databases", () => {
    const otherCwd = mkdtempSync(join(tmpdir(), "agenc-health-state-other-"));
    mkdirSync(join(otherCwd, ".git"));
    const writerA = openStateDatabases({ cwd, agencHome: home });
    const writerB = openStateDatabases({ cwd: otherCwd, agencHome: home });
    try {
      seedStateRows(writerA);
      seedStateRows(writerB);
      const pathsA = resolveStateDatabasePaths({ cwd, agencHome: home });
      const pathsB = resolveStateDatabasePaths({
        cwd: otherCwd,
        agencHome: home,
      });
      const reader = new StateSqliteHealthStatsReader([pathsA, pathsB]);

      expect(reader.readStateStats()).toEqual({
        available: true,
        readonly: true,
        projectDir: pathsA.projectDir,
        agentRuns: 2,
        sessionStateSnapshots: 2,
        inFlightToolCalls: 2,
        logs: 2,
      });
    } finally {
      writerA.close();
      writerB.close();
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });
});

function seedStateRows(driver: StateSqliteDriver): void {
  driver
    .prepareState(
      `INSERT INTO agent_runs (
        id,
        objective,
        status,
        started_at,
        last_active_at,
        current_session_id
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "run-health",
      "health stats",
      "running",
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:01:00.000Z",
      "session-health",
    );
  driver
    .prepareState(
      `INSERT INTO session_state_snapshots (
        session_id,
        snapshot_at,
        conversation_json,
        tool_state_json,
        mcp_connection_state_json
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "session-health",
      "2026-05-01T00:01:00.000Z",
      "[]",
      "{}",
      "{}",
    );
  driver
    .prepareState(
      `INSERT INTO in_flight_tool_calls (
        session_id,
        tool_call_id,
        tool_name,
        args_json,
        status,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "session-health",
      "tool-health",
      "FileRead",
      "{}",
      "running",
      "2026-05-01T00:01:00.000Z",
    );
  driver
    .prepareLogs(
      `INSERT INTO logs (
        timestamp,
        level,
        message
      ) VALUES (?, ?, ?)`,
    )
    .run("2026-05-01T00:01:00.000Z", "info", "health stats");
}
