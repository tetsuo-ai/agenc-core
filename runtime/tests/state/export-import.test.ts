import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENC_STATE_EXPORT_FORMAT,
  exportAgentState,
  importAgentState,
  parseAgenCStateExportPayload,
} from "./export-import.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import { readRotatedToolOutputLog } from "./tool-output-rotation.js";

let sourceHome = "";
let targetHome = "";
let sourceCwd = "";
let targetCwd = "";
let source: StateSqliteDriver;
let target: StateSqliteDriver;

beforeEach(() => {
  sourceHome = mkdtempSync(join(tmpdir(), "agenc-state-export-home-"));
  targetHome = mkdtempSync(join(tmpdir(), "agenc-state-import-home-"));
  sourceCwd = mkdtempSync(join(tmpdir(), "agenc-state-export-cwd-"));
  targetCwd = mkdtempSync(join(tmpdir(), "agenc-state-import-cwd-"));
  mkdirSync(join(sourceCwd, ".git"));
  mkdirSync(join(targetCwd, ".git"));
  source = openStateDatabases({ cwd: sourceCwd, agencHome: sourceHome });
  target = openStateDatabases({ cwd: targetCwd, agencHome: targetHome });
});

afterEach(() => {
  source.close();
  target.close();
  rmSync(sourceHome, { recursive: true, force: true });
  rmSync(targetHome, { recursive: true, force: true });
  rmSync(sourceCwd, { recursive: true, force: true });
  rmSync(targetCwd, { recursive: true, force: true });
});

describe("state export/import", () => {
  it("exports an agent run with its current session snapshots and tool calls", () => {
    seedAgentState(source);

    const payload = exportAgentState(source, "agent-export", {
      now: () => "2026-05-02T00:00:00.000Z",
    });

    expect(payload).toMatchObject({
      format: AGENC_STATE_EXPORT_FORMAT,
      schemaVersion: 1,
      exportedAt: "2026-05-02T00:00:00.000Z",
      projectDir: source.projectDir,
      agentRun: {
        id: "agent-export",
        objective: "debug export",
        status: "running",
        currentSessionId: "session-export",
      },
      sessionStateSnapshots: [
        {
          sessionId: "session-export",
          snapshotAt: "2026-05-01T00:00:00.000Z",
          conversation: [{ role: "user", content: "old" }],
        },
        {
          sessionId: "session-export",
          snapshotAt: "2026-05-01T00:10:00.000Z",
          conversation: [{ role: "assistant", content: "latest" }],
          toolState: { pending: ["tool-export"] },
        },
      ],
      inFlightToolCalls: [
        {
          sessionId: "session-export",
          toolCallId: "tool-export",
          toolName: "FileRead",
          args: { path: "README.md" },
          status: "running",
          recoveryCategory: "idempotent",
          outputPartial: "partial",
        },
      ],
    });
  });

  it("imports an exported payload into another project state database", () => {
    seedAgentState(source);
    seedStaleTargetAgentState(target);
    const payload = exportAgentState(source, "agent-export", {
      now: () => "2026-05-02T00:00:00.000Z",
    });

    expect(snapshotCount(target, "session-stale")).toBe(1);
    const result = importAgentState(target, payload);

    expect(result).toEqual({
      agentId: "agent-export",
      projectDir: target.projectDir,
      sessionIds: ["session-export"],
      snapshotCount: 2,
      toolCallCount: 1,
    });
    expect(agentStatus(target, "agent-export")).toBe("running");
    expect(snapshotCount(target, "session-export")).toBe(2);
    expect(toolCallStatus(target, "session-export", "tool-export")).toBe(
      "running",
    );
    expect(snapshotCount(target, "session-stale")).toBe(0);
    expect(toolCallStatus(target, "session-stale", "tool-stale")).toBeUndefined();
    expect(exportAgentState(target, "agent-export")).toMatchObject({
      agentRun: payload.agentRun,
      sessionStateSnapshots: payload.sessionStateSnapshots,
      inFlightToolCalls: payload.inFlightToolCalls,
    });
  });

  it("caps oversized imported tool output partials through rotation", () => {
    seedAgentState(source);
    const payload = exportAgentState(source, "agent-export");
    const call = payload.inFlightToolCalls[0];
    if (call === undefined) throw new Error("tool call missing");
    const oversized = {
      ...payload,
      inFlightToolCalls: [
        {
          ...call,
          outputPartial: "abcdefghij",
        },
      ],
    };

    importAgentState(target, oversized, {
      agencHome: targetHome,
      outputRotation: {
        outputPartialMaxBytes: 4,
        logMaxBytes: 3,
        rotatedLogCount: 1,
      },
    });

    const row = toolCallOutput(target, "session-export", "tool-export");
    expect(row.output_partial).toBe("abcd");
    expect(row.output_log_path).toBeDefined();
    expect(row.output_log_bytes).toBe(6);
    if (row.output_log_path === null) throw new Error("output log path missing");
    expect(readRotatedToolOutputLog(row.output_log_path, {
      outputPartialMaxBytes: 4,
      logMaxBytes: 3,
      rotatedLogCount: 1,
    })).toBe("efghij");
    expect(existsSync(`${row.output_log_path}.2`)).toBe(false);
  });

  it("omits non-portable spilled log paths from state exports", () => {
    seedAgentState(source);
    source
      .prepareState<[string, number, string, string]>(
        `UPDATE in_flight_tool_calls
         SET output_log_path = ?,
             output_log_bytes = ?
         WHERE session_id = ?
           AND tool_call_id = ?`,
      )
      .run("/tmp/source-machine-tool.log", 42, "session-export", "tool-export");

    const payload = exportAgentState(source, "agent-export");
    const call = payload.inFlightToolCalls[0];
    if (call === undefined) throw new Error("tool call missing");

    expect(call).not.toHaveProperty("outputLogPath");
    expect(call).not.toHaveProperty("outputLogBytes");
    importAgentState(target, payload, { agencHome: targetHome });
    expect(toolCallOutput(target, "session-export", "tool-export")).toMatchObject({
      output_partial: "partial",
      output_log_path: null,
      output_log_bytes: 0,
    });
  });

  it("rejects malformed import payloads before writing rows", () => {
    expect(() => parseAgenCStateExportPayload("{")).toThrow(
      "state import payload is not valid JSON",
    );
    expect(() =>
      importAgentState(target, {
        format: "wrong",
        schemaVersion: 1,
      }),
    ).toThrow("state import payload format must be agenc.state.export");
    expect(agentStatus(target, "agent-export")).toBeUndefined();
  });

  it("rejects inconsistent session rows without clobbering unrelated state", () => {
    seedAgentState(source);
    seedUnrelatedSessionState(target, "session-other", "tool-other");
    const payload = exportAgentState(source, "agent-export");
    const inconsistent = JSON.parse(JSON.stringify(payload)) as {
      readonly agentRun: { readonly currentSessionId: string };
      sessionStateSnapshots: Array<{ sessionId: string }>;
      inFlightToolCalls: Array<{ sessionId: string }>;
    };
    const firstSnapshot = inconsistent.sessionStateSnapshots[0];
    if (firstSnapshot === undefined) throw new Error("snapshot missing");
    firstSnapshot.sessionId = "session-other";

    expect(() => importAgentState(target, inconsistent)).toThrow(
      "does not match agentRun.currentSessionId",
    );
    expect(agentStatus(target, "agent-export")).toBeUndefined();
    expect(snapshotCount(target, "session-other")).toBe(1);
    expect(toolCallStatus(target, "session-other", "tool-other")).toBe(
      "running",
    );
  });

  it("rejects imports whose session id is already owned by another agent", () => {
    seedAgentState(source);
    seedOwnedSessionState(target, {
      agentId: "agent-other",
      sessionId: "session-export",
      toolCallId: "tool-owned",
    });
    const payload = exportAgentState(source, "agent-export");

    expect(() => importAgentState(target, payload)).toThrow(
      "session id session-export is already owned by agent agent-other",
    );
    expect(agentStatus(target, "agent-export")).toBeUndefined();
    expect(agentStatus(target, "agent-other")).toBe("running");
    expect(snapshotCount(target, "session-export")).toBe(1);
    expect(toolCallStatus(target, "session-export", "tool-owned")).toBe(
      "running",
    );
  });

  it("rejects session rows when the agent run has no current session", () => {
    seedAgentState(source);
    const payload = exportAgentState(source, "agent-export");
    const inconsistent = JSON.parse(JSON.stringify(payload)) as {
      agentRun: { currentSessionId?: string };
    };
    delete inconsistent.agentRun.currentSessionId;

    expect(() => importAgentState(target, inconsistent)).toThrow(
      "includes session rows but agentRun.currentSessionId is absent",
    );
    expect(agentStatus(target, "agent-export")).toBeUndefined();
  });
});

function seedAgentState(driver: StateSqliteDriver): void {
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
      "agent-export",
      "debug export",
      "running",
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:11:00.000Z",
      "session-export",
      "client-export",
      "2026-05-01T00:10:00.000Z",
    );
  insertSnapshot(driver, "2026-05-01T00:00:00.000Z", {
    conversation: [{ role: "user", content: "old" }],
    toolState: { pending: [] },
    mcpConnectionState: { connected: false },
  });
  insertSnapshot(driver, "2026-05-01T00:10:00.000Z", {
    conversation: [{ role: "assistant", content: "latest" }],
    toolState: { pending: ["tool-export"] },
    mcpConnectionState: { connected: true },
  });
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
      "session-export",
      "tool-export",
      "FileRead",
      JSON.stringify({ path: "README.md" }),
      "running",
      "idempotent",
      "partial",
      "2026-05-01T00:09:00.000Z",
    );
}

function seedStaleTargetAgentState(driver: StateSqliteDriver): void {
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
      "agent-export",
      "stale import target",
      "blocked",
      "2026-04-01T00:00:00.000Z",
      "2026-04-01T00:01:00.000Z",
      "session-stale",
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
    .run("session-stale", "2026-04-01T00:01:00.000Z", "[]", "{}", "{}");
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
      "session-stale",
      "tool-stale",
      "FileRead",
      "{}",
      "running",
      "2026-04-01T00:01:00.000Z",
    );
}

function seedOwnedSessionState(
  driver: StateSqliteDriver,
  params: {
    readonly agentId: string;
    readonly sessionId: string;
    readonly toolCallId: string;
  },
): void {
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
      params.agentId,
      "owned session",
      "running",
      "2026-04-01T00:00:00.000Z",
      "2026-04-01T00:01:00.000Z",
      params.sessionId,
    );
  seedUnrelatedSessionState(driver, params.sessionId, params.toolCallId);
}

function seedUnrelatedSessionState(
  driver: StateSqliteDriver,
  sessionId: string,
  toolCallId: string,
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
    .run(sessionId, "2026-04-01T00:01:00.000Z", "[]", "{}", "{}");
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
      sessionId,
      toolCallId,
      "FileRead",
      "{}",
      "running",
      "2026-04-01T00:01:00.000Z",
    );
}

function insertSnapshot(
  driver: StateSqliteDriver,
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
      "session-export",
      snapshotAt,
      JSON.stringify(state.conversation),
      JSON.stringify(state.toolState),
      JSON.stringify(state.mcpConnectionState),
    );
}

function agentStatus(
  driver: StateSqliteDriver,
  agentId: string,
): string | undefined {
  return driver
    .prepareState<[string], { status: string }>(
      "SELECT status FROM agent_runs WHERE id = ?",
    )
    .get(agentId)?.status;
}

function snapshotCount(driver: StateSqliteDriver, sessionId: string): number {
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

function toolCallStatus(
  driver: StateSqliteDriver,
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

function toolCallOutput(
  driver: StateSqliteDriver,
  sessionId: string,
  toolCallId: string,
): {
  readonly output_partial: string | null;
  readonly output_log_path: string | null;
  readonly output_log_bytes: number;
} {
  const row = driver
    .prepareState<
      [string, string],
      {
        output_partial: string | null;
        output_log_path: string | null;
        output_log_bytes: number;
      }
    >(
      `SELECT output_partial, output_log_path, output_log_bytes
       FROM in_flight_tool_calls
       WHERE session_id = ? AND tool_call_id = ?`,
    )
    .get(sessionId, toolCallId);
  if (row === undefined) throw new Error("tool call missing");
  return row;
}
