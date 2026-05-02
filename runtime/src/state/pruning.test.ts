import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneTerminalAgentRuns } from "./pruning.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-pruning-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-pruning-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("pruneTerminalAgentRuns", () => {
  it("prunes terminal agent runs according to completed and failed retention windows", () => {
    seedRun("completed-old", "session-completed-old", "completed", "2026-03-01T00:00:00.000Z");
    seedRun("stopped-old", "session-stopped-old", "stopped", "2026-03-02T00:00:00.000Z");
    seedRun("completed-new", "session-completed-new", "completed", "2026-04-20T00:00:00.000Z");
    seedRun("failed-old", "session-failed-old", "failed", "2026-01-01T00:00:00.000Z");
    seedRun("error-old", "session-error-old", "error", "2026-01-02T00:00:00.000Z");
    seedRun("failed-new", "session-failed-new", "failed", "2026-03-20T00:00:00.000Z");
    seedRun("running-old", "session-running-old", "running", "2026-01-01T00:00:00.000Z");

    const report = pruneTerminalAgentRuns(driver, {
      completed_days: 30,
      failed_days: 90,
      now: () => "2026-05-01T00:00:00.000Z",
    });

    expect(report).toMatchObject({
      prunedRuns: 4,
      prunedCompletedRuns: 2,
      prunedFailedRuns: 2,
      prunedSnapshots: 4,
      prunedToolCalls: 4,
    });
    expect(report.prunedSessionIds).toEqual([
      "session-completed-old",
      "session-stopped-old",
      "session-failed-old",
      "session-error-old",
    ]);
    expect(runIds()).toEqual([
      "completed-new",
      "failed-new",
      "running-old",
    ]);
    expect(snapshotCount("session-completed-old")).toBe(0);
    expect(toolCallCount("session-error-old")).toBe(0);
    expect(snapshotCount("session-completed-new")).toBe(1);
    expect(toolCallCount("session-failed-new")).toBe(1);
  });

  it("does nothing when retention windows are disabled", () => {
    seedRun("completed-old", "session-completed-old", "completed", "2026-03-01T00:00:00.000Z");

    const report = pruneTerminalAgentRuns(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
    });

    expect(report.prunedRuns).toBe(0);
    expect(runIds()).toEqual(["completed-old"]);
    expect(snapshotCount("session-completed-old")).toBe(1);
  });
});

function seedRun(
  id: string,
  sessionId: string,
  status: string,
  lastActiveAt: string,
): void {
  driver
    .prepareState(
      `INSERT INTO agent_runs (
        id,
        objective,
        status,
        started_at,
        last_active_at,
        current_session_id,
        created_by_client,
        last_snapshot_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      "prune state",
      status,
      "2026-01-01T00:00:00.000Z",
      lastActiveAt,
      sessionId,
      "client-1",
      lastActiveAt,
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
    .run(sessionId, lastActiveAt, "[]", "{}", "{}");
  driver
    .prepareState(
      `INSERT INTO in_flight_tool_calls (
        session_id,
        tool_call_id,
        tool_name,
        args_json,
        status,
        output_partial,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      `tool-${id}`,
      "FileRead",
      "{}",
      "completed",
      null,
      lastActiveAt,
    );
}

function runIds(): string[] {
  return driver
    .prepareState<[], { id: string }>(
      "SELECT id FROM agent_runs ORDER BY id ASC",
    )
    .all()
    .map((row) => row.id);
}

function snapshotCount(sessionId: string): number {
  return (
    driver
      .prepareState<[string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM session_state_snapshots
         WHERE session_id = ?`,
      )
      .get(sessionId)?.count ?? 0
  );
}

function toolCallCount(sessionId: string): number {
  return (
    driver
      .prepareState<[string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM in_flight_tool_calls
         WHERE session_id = ?`,
      )
      .get(sessionId)?.count ?? 0
  );
}
