import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverDaemonStateOnStartup } from "./recovery.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-recovery-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-recovery-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("recoverDaemonStateOnStartup", () => {
  it("loads recoverable runs from their latest snapshot and fails stale tool calls", () => {
    insertAgentRun({
      id: "run-1",
      objective: "continue work",
      status: "running",
      currentSessionId: "session-1",
      lastSnapshotAt: "2026-05-01T00:10:00.000Z",
    });
    insertAgentRun({
      id: "run-2",
      objective: "finished work",
      status: "completed",
      currentSessionId: "session-2",
    });
    insertSnapshot("session-1", "2026-05-01T00:00:00.000Z", {
      conversation: [{ role: "user", content: "old" }],
      toolState: { pending: [] },
      mcpConnectionState: { connected: false },
    });
    insertSnapshot("session-1", "2026-05-01T00:10:00.000Z", {
      conversation: [{ role: "assistant", content: "latest" }],
      toolState: { pending: ["tool-1"] },
      mcpConnectionState: { connected: true },
    });
    insertToolCall({
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "FileWrite",
      args: { path: "a.txt" },
      status: "running",
      outputPartial: "partial output",
    });
    insertToolCall({
      sessionId: "session-1",
      toolCallId: "tool-2",
      toolName: "FileRead",
      args: { path: "b.txt" },
      status: "completed",
    });

    const report = recoverDaemonStateOnStartup(driver, {
      now: () => "2026-05-01T00:20:00.000Z",
    });

    expect(report.recoveredAt).toBe("2026-05-01T00:20:00.000Z");
    expect(report.recoveredRuns).toHaveLength(1);
    expect(report.recoveredRuns[0]).toMatchObject({
      id: "run-1",
      objective: "continue work",
      status: "running",
      currentSessionId: "session-1",
      lastSnapshotAt: "2026-05-01T00:10:00.000Z",
      latestSnapshot: {
        sessionId: "session-1",
        snapshotAt: "2026-05-01T00:10:00.000Z",
        conversation: [{ role: "assistant", content: "latest" }],
        toolState: { pending: ["tool-1"] },
        mcpConnectionState: { connected: true },
      },
    });
    expect(report.failedToolCalls).toEqual([
      {
        projectDir: driver.projectDir,
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "FileWrite",
        args: { path: "a.txt" },
        statusBefore: "running",
        startedAt: "2026-05-01T00:05:00.000Z",
        outputPartial: "partial output",
      },
    ]);
    expect(report.warnings).toEqual([]);
    expect(toolCallStatus("session-1", "tool-1")).toBe("failed");
    expect(toolCallStatus("session-1", "tool-2")).toBe("completed");
  });

  it("keeps daemon startup recovery non-throwing when snapshot JSON is invalid", () => {
    insertAgentRun({
      id: "run-bad-snapshot",
      objective: "recover malformed snapshot",
      status: "running",
      currentSessionId: "session-bad",
    });
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
      .run("session-bad", "2026-05-01T00:00:00.000Z", "{", "{}", "{}");

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toHaveLength(1);
    expect(report.recoveredRuns[0]?.latestSnapshot).toBeUndefined();
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: "snapshot_json_invalid",
        runId: "run-bad-snapshot",
        sessionId: "session-bad",
      }),
    ]);
  });
});

function insertAgentRun(params: {
  readonly id: string;
  readonly objective: string;
  readonly status: string;
  readonly currentSessionId?: string;
  readonly lastSnapshotAt?: string;
}): void {
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
      params.id,
      params.objective,
      params.status,
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:05:00.000Z",
      params.currentSessionId ?? null,
      "client-1",
      params.lastSnapshotAt ?? null,
    );
}

function insertSnapshot(
  sessionId: string,
  snapshotAt: string,
  state: {
    readonly conversation: unknown;
    readonly toolState: unknown;
    readonly mcpConnectionState: unknown;
  },
): void {
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
      sessionId,
      snapshotAt,
      JSON.stringify(state.conversation),
      JSON.stringify(state.toolState),
      JSON.stringify(state.mcpConnectionState),
    );
}

function insertToolCall(params: {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly status: string;
  readonly outputPartial?: string;
}): void {
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
      params.sessionId,
      params.toolCallId,
      params.toolName,
      JSON.stringify(params.args),
      params.status,
      params.outputPartial ?? null,
      "2026-05-01T00:05:00.000Z",
    );
}

function toolCallStatus(
  sessionId: string,
  toolCallId: string,
): string | undefined {
  return driver
    .prepareState<[string, string], { status: string }>(
      `SELECT status
       FROM in_flight_tool_calls
       WHERE session_id = ? AND tool_call_id = ?`,
    )
    .get(sessionId, toolCallId)?.status;
}
