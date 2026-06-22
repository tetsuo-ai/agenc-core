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
  it("loads recoverable runs from their latest snapshot and applies stale tool recovery policy", () => {
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
      toolCallId: "tool-3",
      toolName: "FileRead",
      args: { path: "c.txt" },
      status: "running",
      recoveryCategory: "idempotent",
    });
    insertToolCall({
      sessionId: "session-1",
      toolCallId: "tool-4",
      toolName: "AskUserQuestion",
      args: { question: "Continue?" },
      status: "running",
      recoveryCategory: "interactive",
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
        toolState: {
          pending: [],
          inFlight: {
            "tool-3": {
              status: "replay_pending",
              recoveryAction: "replay",
            },
          },
          completed: {
            "tool-1": {
              status: "poisoned",
              recoveryAction: "poison",
            },
            "tool-4": {
              status: "recovery_cancelled",
              recoveryAction: "cancel",
            },
          },
        },
        mcpConnectionState: { connected: true },
      },
    });
    expect(report.recoveredToolCalls).toEqual([
      {
        projectDir: driver.projectDir,
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "FileWrite",
        args: { path: "a.txt" },
        statusBefore: "running",
        statusAfter: "poisoned",
        recoveryCategory: "side-effecting",
        recoveryAction: "poison",
        startedAt: "2026-05-01T00:05:00.000Z",
        outputPartial: "partial output",
      },
      {
        projectDir: driver.projectDir,
        sessionId: "session-1",
        toolCallId: "tool-3",
        toolName: "FileRead",
        args: { path: "c.txt" },
        statusBefore: "running",
        statusAfter: "replay_pending",
        recoveryCategory: "idempotent",
        recoveryAction: "replay",
        startedAt: "2026-05-01T00:05:00.000Z",
      },
      {
        projectDir: driver.projectDir,
        sessionId: "session-1",
        toolCallId: "tool-4",
        toolName: "AskUserQuestion",
        args: { question: "Continue?" },
        statusBefore: "running",
        statusAfter: "recovery_cancelled",
        recoveryCategory: "interactive",
        recoveryAction: "cancel",
        startedAt: "2026-05-01T00:05:00.000Z",
      },
    ]);
    expect(report.warnings).toEqual([]);
    expect(toolCallStatus("session-1", "tool-1")).toBe("poisoned");
    expect(toolCallStatus("session-1", "tool-2")).toBe("completed");
    expect(toolCallStatus("session-1", "tool-3")).toBe("replay_pending");
    expect(toolCallStatus("session-1", "tool-4")).toBe("recovery_cancelled");

    const secondReport = recoverDaemonStateOnStartup(driver, {
      now: () => "2026-05-01T00:25:00.000Z",
    });
    expect(secondReport.recoveredToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "tool-3",
        statusBefore: "replay_pending",
        statusAfter: "replay_pending",
        recoveryCategory: "idempotent",
        recoveryAction: "replay",
      }),
      expect.objectContaining({
        toolCallId: "tool-1",
        statusBefore: "poisoned",
        statusAfter: "poisoned",
        recoveryCategory: "side-effecting",
        recoveryAction: "poison",
      }),
      expect.objectContaining({
        toolCallId: "tool-4",
        statusBefore: "recovery_cancelled",
        statusAfter: "recovery_cancelled",
        recoveryCategory: "interactive",
        recoveryAction: "cancel",
      }),
    ]);
  });

  it("drops array-shaped agent metadata during startup recovery", () => {
    insertAgentRun({
      id: "run-array-metadata",
      objective: "recover metadata",
      status: "running",
    });
    driver
      .prepareState<[string, string]>(
        "UPDATE agent_runs SET metadata_json = ? WHERE id = ?",
      )
      .run(JSON.stringify(["spoof"]), "run-array-metadata");

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toHaveLength(1);
    expect(report.recoveredRuns[0]).not.toHaveProperty("metadata");
  });

  it("drops array-shaped recovered tool-state maps before applying recovered tool calls", () => {
    insertAgentRun({
      id: "run-array-tool-state",
      objective: "recover tool state",
      status: "running",
      currentSessionId: "session-array-tool-state",
    });
    insertSnapshot("session-array-tool-state", "2026-05-01T00:00:00.000Z", {
      conversation: [],
      toolState: {
        pending: ["tool-replay", "tool-poison"],
        inFlight: ["spoof"],
        completed: ["spoof"],
      },
      mcpConnectionState: {},
    });
    insertToolCall({
      sessionId: "session-array-tool-state",
      toolCallId: "tool-replay",
      toolName: "FileRead",
      args: { path: "a.txt" },
      status: "running",
      recoveryCategory: "idempotent",
    });
    insertToolCall({
      sessionId: "session-array-tool-state",
      toolCallId: "tool-poison",
      toolName: "FileWrite",
      args: { path: "b.txt" },
      status: "running",
      recoveryCategory: "side-effecting",
    });

    const report = recoverDaemonStateOnStartup(driver);
    const toolState = report.recoveredRuns[0]?.latestSnapshot?.toolState as
      | {
          readonly pending?: unknown;
          readonly inFlight?: unknown;
          readonly completed?: unknown;
        }
      | undefined;

    expect(toolState?.pending).toEqual([]);
    expect(toolState?.inFlight).toEqual({
      "tool-replay": expect.objectContaining({
        status: "replay_pending",
        recoveryAction: "replay",
      }),
    });
    expect(toolState?.completed).toEqual({
      "tool-poison": expect.objectContaining({
        status: "poisoned",
        recoveryAction: "poison",
      }),
    });
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

  it("does not surface normally cancelled rows as startup recovery", () => {
    insertToolCall({
      sessionId: "session-cancelled",
      toolCallId: "tool-cancelled",
      toolName: "AskUserQuestion",
      args: { question: "Continue?" },
      status: "cancelled",
      recoveryCategory: "interactive",
    });

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredToolCalls).toEqual([]);
    expect(toolCallStatus("session-cancelled", "tool-cancelled")).toBe(
      "cancelled",
    );
  });

  it("poisons idempotent recovery rows with malformed arguments", () => {
    insertToolCall({
      sessionId: "session-bad-args",
      toolCallId: "tool-bad-args",
      toolName: "FileRead",
      args: null,
      argsJson: "{",
      status: "running",
      recoveryCategory: "idempotent",
    });

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "tool-bad-args",
        statusBefore: "running",
        statusAfter: "poisoned",
        recoveryCategory: "idempotent",
        recoveryAction: "poison",
      }),
    ]);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: "tool_args_json_invalid",
        sessionId: "session-bad-args",
        toolCallId: "tool-bad-args",
      }),
    ]);
    expect(toolCallStatus("session-bad-args", "tool-bad-args")).toBe(
      "poisoned",
    );
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
  readonly argsJson?: string;
  readonly status: string;
  readonly recoveryCategory?: string;
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
        recovery_category,
        output_partial,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.sessionId,
      params.toolCallId,
      params.toolName,
      params.argsJson ?? JSON.stringify(params.args),
      params.status,
      params.recoveryCategory ?? "side-effecting",
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
