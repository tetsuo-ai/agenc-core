import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pruneSessionSnapshotsForSession,
  pruneSessionSnapshotsPerSession,
  pruneSessionStateSnapshots,
  pruneTerminalAgentRuns,
  SESSION_SNAPSHOT_HARD_CAP,
} from "./pruning.js";
import { defaultConfig } from "../../src/config/schema.js";
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
    seedRun("errored-old", "session-errored-old", "errored", "2026-01-03T00:00:00.000Z");
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
      prunedRuns: 5,
      prunedCompletedRuns: 2,
      prunedFailedRuns: 3,
      prunedSnapshots: 5,
      prunedToolCalls: 5,
    });
    expect(report.prunedSessionIds).toEqual([
      "session-completed-old",
      "session-stopped-old",
      "session-failed-old",
      "session-error-old",
      "session-errored-old",
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

// Review P0-2: the table-wide sweep above never deleted a row in the live
// daemon (5,607 rows / 1.16 GB for one session under the default 64 MiB cap)
// and cost a LENGTH() scan of the whole table per pass. The per-session prune
// is bounded by the hard cap so it can run on every snapshot write.
describe("pruneSessionSnapshotsForSession", () => {
  it("keeps a session under the hard cap after 10,000 writes with the default retention", () => {
    seedRun("agent-flood", "session-flood", "running", "2026-05-01T00:00:00.000Z");
    const retention = defaultConfig().agent?.retention;
    expect(retention).toMatchObject({
      snapshot_days: 3,
      snapshot_max_count: 10_000,
      snapshot_max_bytes: 67_108_864,
    });
    const baseMs = Date.parse("2026-05-01T00:00:01.000Z");
    driver.transaction(() => {
      for (let index = 0; index < 10_000; index++) {
        insertSnapshot(
          "session-flood",
          new Date(baseMs + index).toISOString(),
          {
            conversation: [{ role: "assistant", content: "x".repeat(1024) }],
            toolState: { index },
            mcpConnectionState: {},
          },
        );
      }
    });
    expect(snapshotCount("session-flood")).toBe(10_001);

    const report = pruneSessionSnapshotsForSession(driver, "session-flood", {
      ...retention,
      now: () => "2026-05-01T00:00:20.000Z",
    });

    expect(report).toEqual({
      prunedSnapshots: 10_001 - SESSION_SNAPSHOT_HARD_CAP,
      prunedSessionIds: ["session-flood"],
    });
    expect(snapshotCount("session-flood")).toBe(SESSION_SNAPSHOT_HARD_CAP);
    expect(snapshotTimes("session-flood").at(-1)).toBe(
      new Date(baseMs + 9_999).toISOString(),
    );
    // A second pass is a no-op over the retained rows.
    expect(
      pruneSessionSnapshotsForSession(driver, "session-flood", {
        ...retention,
        now: () => "2026-05-01T00:00:20.000Z",
      }),
    ).toEqual({ prunedSnapshots: 0, prunedSessionIds: [] });
  });

  it("applies a configured count cap below the hard cap and keeps the newest rows", () => {
    for (const second of [1, 2, 3, 4, 5]) {
      insertSnapshot("session-count", `2026-05-01T00:00:0${second}.000Z`, {
        conversation: [],
        toolState: {},
        mcpConnectionState: {},
      });
    }

    const report = pruneSessionSnapshotsForSession(driver, "session-count", {
      snapshot_max_count: 2,
    });

    expect(report.prunedSnapshots).toBe(3);
    expect(snapshotTimes("session-count")).toEqual([
      "2026-05-01T00:00:04.000Z",
      "2026-05-01T00:00:05.000Z",
    ]);
  });

  it("applies the age cutoff but always keeps the newest row", () => {
    insertSnapshot("session-age", "2026-04-20T00:00:00.000Z", {
      conversation: [],
      toolState: {},
      mcpConnectionState: {},
    });
    insertSnapshot("session-age", "2026-04-21T00:00:00.000Z", {
      conversation: [],
      toolState: {},
      mcpConnectionState: {},
    });

    pruneSessionSnapshotsForSession(driver, "session-age", {
      snapshot_days: 3,
      now: () => "2026-05-01T00:00:00.000Z",
    });

    expect(snapshotTimes("session-age")).toEqual(["2026-04-21T00:00:00.000Z"]);
  });

  it("applies the byte cap newest-first over the surviving rows", () => {
    insertSnapshot("session-bytes", "2026-05-01T00:00:01.000Z", {
      conversation: [],
      toolState: {},
      mcpConnectionState: { payload: "z".repeat(128) },
    });
    insertSnapshot("session-bytes", "2026-05-01T00:00:02.000Z", {
      conversation: [],
      toolState: { payload: "y".repeat(40) },
      mcpConnectionState: {},
    });
    insertSnapshot("session-bytes", "2026-05-01T00:00:03.000Z", {
      conversation: [{ payload: "x".repeat(40) }],
      toolState: {},
      mcpConnectionState: {},
    });

    const report = pruneSessionSnapshotsForSession(driver, "session-bytes", {
      snapshot_max_bytes: 150,
    });

    expect(report.prunedSnapshots).toBe(1);
    expect(snapshotTimes("session-bytes")).toEqual([
      "2026-05-01T00:00:02.000Z",
      "2026-05-01T00:00:03.000Z",
    ]);
  });

  it("leaves other sessions alone even when they share the agent", () => {
    seedRun("agent-shared", "session-shared-a", "running", "2026-05-01T00:00:00.000Z");
    seedSessionAgentLink("session-shared-b", "agent-shared");
    for (const second of [1, 2, 3]) {
      insertSnapshot("session-shared-a", `2026-05-01T00:00:0${second}.000Z`, {
        conversation: [],
        toolState: {},
        mcpConnectionState: {},
      });
      insertSnapshot("session-shared-b", `2026-05-01T00:00:0${second}.000Z`, {
        conversation: [],
        toolState: {},
        mcpConnectionState: {},
      });
    }

    pruneSessionSnapshotsForSession(driver, "session-shared-a", {
      snapshot_max_count: 1,
    });

    expect(snapshotCount("session-shared-a")).toBe(1);
    expect(snapshotCount("session-shared-b")).toBe(3);
  });

  it("pruneSessionSnapshotsPerSession caps every session independently", () => {
    const baseMs = Date.parse("2026-05-01T00:00:00.000Z");
    driver.transaction(() => {
      for (const sessionId of ["session-many-a", "session-many-b"]) {
        for (let index = 0; index < SESSION_SNAPSHOT_HARD_CAP + 10; index++) {
          insertSnapshot(sessionId, new Date(baseMs + index).toISOString(), {
            conversation: [],
            toolState: {},
            mcpConnectionState: {},
          });
        }
      }
    });

    const report = pruneSessionSnapshotsPerSession(driver);

    expect(report).toEqual({
      prunedSnapshots: 20,
      prunedSessionIds: ["session-many-a", "session-many-b"],
    });
    expect(snapshotCount("session-many-a")).toBe(SESSION_SNAPSHOT_HARD_CAP);
    expect(snapshotCount("session-many-b")).toBe(SESSION_SNAPSHOT_HARD_CAP);
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
