import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgenCSessionSnapshotPolicy } from "./snapshot-policy.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-snapshot-policy-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-snapshot-policy-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("AgenCSessionSnapshotPolicy", () => {
  it("snapshots message, tool, and status triggers into session_state_snapshots", () => {
    seedRun("run-1", "session-1");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:02.000Z",
        "2026-05-01T00:00:03.000Z",
      ]),
    });

    policy.recordMessageExchange({
      sessionId: "session-1",
      agentId: "run-1",
      content: "hello",
      messageId: "message-1",
      streamId: "stream-1",
      acceptedAt: "2026-05-01T00:00:00.000Z",
    });
    policy.recordSessionEvent("session-1", {
      method: "event.tool_request",
      params: {
        eventId: "event-tool-1",
        requestId: "tool-1",
        toolName: "FileRead",
        input: { path: "a.txt" },
      },
    });
    policy.recordSessionEvent("session-1", {
      method: "event.session_event",
      params: {
        event: {
          type: "tool_call_completed",
          payload: {
            callId: "tool-1",
            result: "ok",
            isError: false,
          },
        },
      },
    });
    policy.recordAgentStatusTransition({
      sessionId: "session-1",
      agentId: "run-1",
      status: "running",
      transitionAt: "2026-05-01T00:00:03.000Z",
    });

    expect(snapshotCount("session-1")).toBe(4);
    const latest = latestSnapshot("session-1");
    expect(latest.toolState).toMatchObject({
      lastTrigger: "agent_status",
      inFlight: {},
      completed: {
        "tool-1": {
          requestId: "tool-1",
          status: "completed",
          result: "ok",
        },
      },
      statusTransitions: [
        {
          agentId: "run-1",
          status: "running",
          transitionAt: "2026-05-01T00:00:03.000Z",
        },
      ],
    });
    expect(latest.conversation).toEqual([
      {
        role: "user",
        agentId: "run-1",
        content: "hello",
        messageId: "message-1",
        streamId: "stream-1",
        acceptedAt: "2026-05-01T00:00:00.000Z",
      },
    ]);
    expect(runLastSnapshotAt("run-1")).toBe("2026-05-01T00:00:03.000Z");
  });

  it("periodically flushes tracked sessions and stops the timer", () => {
    const clearInterval = vi.fn();
    let tick: (() => void) | undefined;
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:30.000Z",
      ]),
      setInterval: (callback, intervalMs) => {
        expect(intervalMs).toBe(30_000);
        tick = callback;
        return { unref: vi.fn() };
      },
      clearInterval,
    });

    policy.recordMessageExchange({
      sessionId: "session-periodic",
      agentId: "agent-periodic",
      content: "watch",
      messageId: "message-periodic",
      streamId: "stream-periodic",
      acceptedAt: "2026-05-01T00:00:00.000Z",
    });
    policy.startPeriodic();
    tick?.();
    policy.stopPeriodic();

    expect(snapshotCount("session-periodic")).toBe(2);
    expect(latestSnapshot("session-periodic").toolState).toMatchObject({
      lastTrigger: "periodic",
    });
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it("hydrates recovered session state before periodic flush", () => {
    seedRun("run-hydrate", "session-hydrate");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:30.000Z"]),
    });

    policy.hydrateSession({
      sessionId: "session-hydrate",
      snapshotAt: "2026-05-01T00:00:10.000Z",
      conversation: [{ role: "assistant", content: "previous" }],
      toolState: {
        pending: ["tool-hydrate"],
        inFlight: {
          "tool-hydrate": { requestId: "tool-hydrate", status: "running" },
        },
      },
      mcpConnectionState: { connected: true },
    });
    policy.flushPeriodic();

    const latest = latestSnapshot("session-hydrate");
    expect(latest.conversation).toEqual([
      { role: "assistant", content: "previous" },
    ]);
    expect(latest.toolState).toMatchObject({
      lastTrigger: "periodic",
      pending: ["tool-hydrate"],
      inFlight: {
        "tool-hydrate": { requestId: "tool-hydrate", status: "running" },
      },
    });
    expect(latest.mcpConnectionState).toMatchObject({ connected: true });
    expect(runLastSnapshotAt("run-hydrate")).toBe(
      "2026-05-01T00:00:30.000Z",
    );
  });

  it("keeps tool identity for completion-only tool events", () => {
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:00.000Z"]),
    });

    policy.recordSessionEvent("session-completion-only", {
      method: "event.session_event",
      params: {
        event: {
          type: "tool_call_completed",
          payload: {
            callId: "tool-completion-only",
            result: "done",
            isError: false,
            metadata: {
              toolName: "FileRead",
            },
          },
        },
      },
    });

    expect(latestSnapshot("session-completion-only").toolState).toMatchObject({
      completed: {
        "tool-completion-only": {
          requestId: "tool-completion-only",
          toolName: "FileRead",
          status: "completed",
          result: "done",
        },
      },
    });
  });
});

function seedRun(runId: string, sessionId: string): void {
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
      runId,
      "snapshot work",
      "running",
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
      sessionId,
      "client-1",
      null,
    );
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

function latestSnapshot(sessionId: string): {
  readonly conversation: unknown;
  readonly toolState: unknown;
  readonly mcpConnectionState: unknown;
} {
  const row = driver
    .prepareState<
      [string],
      {
        conversation_json: string;
        tool_state_json: string;
        mcp_connection_state_json: string;
      }
    >(
      `SELECT conversation_json, tool_state_json, mcp_connection_state_json
       FROM session_state_snapshots
       WHERE session_id = ?
       ORDER BY snapshot_at DESC
       LIMIT 1`,
    )
    .get(sessionId);
  if (row === undefined) throw new Error("snapshot missing");
  return {
    conversation: JSON.parse(row.conversation_json),
    toolState: JSON.parse(row.tool_state_json),
    mcpConnectionState: JSON.parse(row.mcp_connection_state_json),
  };
}

function runLastSnapshotAt(runId: string): string | null {
  return (
    driver
      .prepareState<[string], { last_snapshot_at: string | null }>(
        "SELECT last_snapshot_at FROM agent_runs WHERE id = ?",
      )
      .get(runId)?.last_snapshot_at ?? null
  );
}

function clock(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index] ?? values.at(-1);
    if (value === undefined) throw new Error("empty clock");
    index += 1;
    return value;
  };
}
