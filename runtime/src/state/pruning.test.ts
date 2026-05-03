import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pruneSessionStateSnapshots,
  pruneTerminalAgentRuns,
} from "./pruning.js";
import { recoverDaemonStateOnStartup } from "./recovery.js";
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
    seedSessionAgentLink("session-completed-old", "completed-old");
    seedSessionAgentLink("session-completed-new", "completed-new");

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
    expect(sessionAgent("session-completed-old")).toBeUndefined();
    expect(sessionAgent("session-completed-new")).toBe("completed-new");
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

  it("prunes agent snapshots by age and count across multiple sessions", () => {
    seedRun("agent-snapshots", "session-snapshots-a", "running", "2026-05-01T00:00:00.000Z");
    seedSessionAgentLink("session-snapshots-b", "agent-snapshots");
    insertSnapshot("session-snapshots-a", "2026-04-30T00:00:00.000Z", {
      conversation: [{ role: "assistant", content: "recent" }],
      toolState: {},
      mcpConnectionState: {},
    });
    insertSnapshot("session-snapshots-a", "2026-04-20T00:00:00.000Z", {
      conversation: [{ role: "assistant", content: "past-age" }],
      toolState: {},
      mcpConnectionState: {},
    });
    insertSnapshot("session-snapshots-b", "2026-05-01T00:00:01.000Z", {
      conversation: [{ role: "assistant", content: "latest-b" }],
      toolState: {},
      mcpConnectionState: {},
    });
    insertSnapshot("session-snapshots-b", "2026-04-30T00:00:01.000Z", {
      conversation: [{ role: "assistant", content: "recent-b" }],
      toolState: {},
      mcpConnectionState: {},
    });
    insertSnapshot("session-snapshots-b", "2026-04-29T00:00:00.000Z", {
      conversation: [{ role: "assistant", content: "past-count" }],
      toolState: {},
      mcpConnectionState: {},
    });

    const report = pruneSessionStateSnapshots(driver, {
      snapshot_days: 3,
      snapshot_max_count: 3,
      now: () => "2026-05-01T00:00:00.000Z",
    }, "session-snapshots-a");

    expect(report).toEqual({
      prunedSnapshots: 3,
      prunedSessionIds: ["session-snapshots-a", "session-snapshots-b"],
    });
    expect(snapshotTimes("session-snapshots-a")).toEqual([
      "2026-05-01T00:00:00.000Z",
    ]);
    expect(snapshotTimes("session-snapshots-b")).toEqual([
      "2026-04-30T00:00:01.000Z",
      "2026-05-01T00:00:01.000Z",
    ]);
  });

  it("prunes older agent snapshots past the combined byte cap", () => {
    seedRun("agent-byte-cap", "session-byte-a", "running", "2026-05-01T00:00:00.000Z");
    seedSessionAgentLink("session-byte-b", "agent-byte-cap");
    insertSnapshot("session-byte-b", "2026-05-01T00:00:01.000Z", {
      conversation: [],
      toolState: {},
      mcpConnectionState: {},
    });
    insertSnapshot("session-byte-a", "2026-04-30T00:00:00.000Z", {
      conversation: [{ role: "assistant", content: "x".repeat(128) }],
      toolState: {},
      mcpConnectionState: {},
    });
    insertSnapshot("session-byte-b", "2026-04-29T00:00:00.000Z", {
      conversation: [{ role: "assistant", content: "y".repeat(128) }],
      toolState: {},
      mcpConnectionState: {},
    });

    const report = pruneSessionStateSnapshots(driver, {
      snapshot_max_bytes: 32,
      now: () => "2026-05-01T00:00:00.000Z",
    }, "session-byte-a");

    expect(report).toEqual({
      prunedSnapshots: 2,
      prunedSessionIds: ["session-byte-a", "session-byte-b"],
    });
    expect(snapshotTimes("session-byte-a")).toEqual([
      "2026-05-01T00:00:00.000Z",
    ]);
    expect(snapshotTimes("session-byte-b")).toEqual([
      "2026-05-01T00:00:01.000Z",
    ]);
  });

  it("keeps the latest recovery snapshot even when it exceeds the byte cap", () => {
    seedRun("agent-oversized", "session-oversized", "running", "2026-05-01T00:00:00.000Z");
    insertSnapshot("session-oversized", "2026-05-01T00:00:01.000Z", {
      conversation: [{ role: "assistant", content: "z".repeat(128) }],
      toolState: {},
      mcpConnectionState: {},
    });

    const report = pruneSessionStateSnapshots(driver, {
      snapshot_max_bytes: 32,
      now: () => "2026-05-01T00:00:01.000Z",
    });

    expect(report).toEqual({
      prunedSnapshots: 1,
      prunedSessionIds: ["session-oversized"],
    });
    expect(snapshotTimes("session-oversized")).toEqual([
      "2026-05-01T00:00:01.000Z",
    ]);
  });

  it("preserves the current-session recovery snapshot under the byte cap", () => {
    seedRun("agent-many-latest", "session-latest-a", "running", "2026-05-01T00:00:00.000Z");
    seedSessionAgentLink("session-latest-b", "agent-many-latest");
    insertSnapshot("session-latest-a", "2026-05-01T00:00:02.000Z", {
      conversation: [{ role: "assistant", content: "a".repeat(128) }],
      toolState: {},
      mcpConnectionState: {},
    });
    insertSnapshot("session-latest-b", "2026-05-01T00:00:03.000Z", {
      conversation: [{ role: "assistant", content: "b".repeat(128) }],
      toolState: {},
      mcpConnectionState: {},
    });

    const report = pruneSessionStateSnapshots(driver, {
      snapshot_max_bytes: 32,
      now: () => "2026-05-01T00:00:03.000Z",
    }, "session-latest-b");

    expect(report).toEqual({
      prunedSnapshots: 1,
      prunedSessionIds: ["session-latest-a"],
    });
    expect(snapshotTimes("session-latest-a")).toEqual([
      "2026-05-01T00:00:02.000Z",
    ]);
    expect(snapshotTimes("session-latest-b")).toEqual([
      "2026-05-01T00:00:03.000Z",
    ]);
    const recovery = recoverDaemonStateOnStartup(driver, {
      now: () => "2026-05-01T00:00:04.000Z",
    });
    expect(recovery.warnings).toEqual([]);
    expect(recovery.recoveredRuns[0]?.latestSnapshot).toMatchObject({
      sessionId: "session-latest-a",
      snapshotAt: "2026-05-01T00:00:02.000Z",
    });
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

function seedSessionAgentLink(sessionId: string, agentId: string): void {
  driver
    .prepareState(
      `INSERT INTO session_agent_links (
        session_id,
        agent_id
      ) VALUES (?, ?)`,
    )
    .run(sessionId, agentId);
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

function snapshotTimes(sessionId: string): string[] {
  return driver
    .prepareState<[string], { snapshot_at: string }>(
      `SELECT snapshot_at
       FROM session_state_snapshots
       WHERE session_id = ?
       ORDER BY snapshot_at ASC`,
    )
    .all(sessionId)
    .map((row) => row.snapshot_at);
}

function sessionAgent(sessionId: string): string | undefined {
  return driver
    .prepareState<[string], { agent_id: string }>(
      "SELECT agent_id FROM session_agent_links WHERE session_id = ?",
    )
    .get(sessionId)?.agent_id;
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
