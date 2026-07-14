import { afterEach, describe, expect, it } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import { AgenCDaemonHealthService, toHealthMemoryStats } from "./health.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";

const workspaces = createTempWorkspaceFixture("agenc-health-workspace-");

afterEach(async () => {
  await workspaces.cleanup();
});

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("test sequence exhausted");
    }
    index += 1;
    return value;
  };
}

describe("AgenC daemon health service", () => {
  it("answers ping with a timestamped ok payload", () => {
    const health = new AgenCDaemonHealthService({
      nowMs: () => Date.parse("2026-05-01T10:00:00.000Z"),
    });

    expect(health.ping()).toEqual({
      ok: true,
      now: "2026-05-01T10:00:00.000Z",
    });
  });

  it("reports readiness and uptime", () => {
    const health = new AgenCDaemonHealthService({
      startedAtMs: 1000,
      nowMs: () => 1750,
      ready: () => false,
    });

    expect(health.ready()).toEqual({
      ready: false,
      uptimeMs: 750,
      now: "1970-01-01T00:00:01.750Z",
    });
  });

  it("reports active sessions, memory, and uptime in stats", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1", "session_2"]),
      now: sequence([
        "2026-05-01T10:00:00.000Z",
        "2026-05-01T10:00:01.000Z",
        "2026-05-01T10:00:02.000Z",
      ]),
    });
    await sessions.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    await sessions.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    await sessions.terminateSession({ sessionId: "session_2" });

    const health = new AgenCDaemonHealthService({
      startedAtMs: 1000,
      nowMs: () => 2500,
      sessionCounter: sessions,
      memoryUsage: () => ({
        rss: 1,
        heapTotal: 2,
        heapUsed: 3,
        external: 4,
        arrayBuffers: 5,
      }),
    });

    await expect(health.stats()).resolves.toEqual({
      uptimeMs: 1500,
      now: "1970-01-01T00:00:02.500Z",
      sessions: {
        active: 1,
        closed: 1,
        total: 2,
      },
      memory: {
        rss: 1,
        heapTotal: 2,
        heapUsed: 3,
        external: 4,
        arrayBuffers: 5,
      },
    });
  });

  it("includes read-only state stats when a state counter is configured", async () => {
    const health = new AgenCDaemonHealthService({
      startedAtMs: 1000,
      nowMs: () => 2500,
      stateCounter: {
        readStateStats: () => ({
          available: true,
          readonly: true,
          projectDir: "/tmp/agenc-project",
          agentRuns: 2,
          sessionStateSnapshots: 3,
          inFlightToolCalls: 4,
          logs: 5,
        }),
      },
      memoryUsage: () => ({
        rss: 1,
        heapTotal: 2,
        heapUsed: 3,
        external: 4,
        arrayBuffers: 5,
      }),
    });

    await expect(health.stats()).resolves.toMatchObject({
      uptimeMs: 1500,
      state: {
        available: true,
        readonly: true,
        projectDir: "/tmp/agenc-project",
        agentRuns: 2,
        sessionStateSnapshots: 3,
        inFlightToolCalls: 4,
        logs: 5,
      },
    });
  });

  it("normalizes Node memory usage into the protocol shape", () => {
    expect(
      toHealthMemoryStats({
        rss: 10,
        heapTotal: 20,
        heapUsed: 30,
        external: 40,
        arrayBuffers: 50,
      }),
    ).toEqual({
      rss: 10,
      heapTotal: 20,
      heapUsed: 30,
      external: 40,
      arrayBuffers: 50,
    });
  });
});
