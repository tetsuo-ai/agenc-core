import { describe, expect, it } from "vitest";
import {
  AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT,
  AGENC_PORTAL_PROTOCOL_VERSION,
  createAgenCPortalMobileStatusSnapshot,
  type AgenCPortalDashboardSnapshot,
} from "./index.js";

function createDashboardSnapshot(): AgenCPortalDashboardSnapshot {
  return {
    protocolVersion: AGENC_PORTAL_PROTOCOL_VERSION,
    connection: {
      kind: "local-daemon",
      label: "Local daemon",
      endpoint: AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT,
    },
    connectionState: {
      status: "connected",
      target: {
        kind: "local-daemon",
        label: "Local daemon",
        endpoint: AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT,
      },
      initialized: true,
      error: "/private/daemon-error",
      updatedAt: "2026-05-06T10:00:00.000Z",
    },
    auth: {
      authenticated: true,
      provider: "local",
      identity: {
        accountId: "acct-secret",
        displayName: "Sensitive User",
        email: "urn:agenc:test:sensitive-identity",
        plan: "team",
      },
      error: "auth-secret",
      updatedAt: "2026-05-06T10:01:00.000Z",
    },
    sessions: [
      {
        sessionId: "session-wait",
        agentId: "agent-wait",
        title: "Needs input",
        cwd: "/private/workspace",
        status: "waiting",
        updatedAt: "2026-05-06T11:30:00.000Z",
      },
      {
        sessionId: "session-run",
        agentId: "agent-run",
        title: "Running session",
        cwd: "/private/run",
        status: "running",
        updatedAt: "2026-05-06T09:30:00.000Z",
      },
      {
        sessionId: "session-idle",
        agentId: null,
        title: "Idle session",
        cwd: "/private/idle",
        status: "idle",
        updatedAt: "2026-05-06T07:00:00.000Z",
      },
      {
        sessionId: "session-stop",
        agentId: null,
        title: "Stopped session",
        cwd: "/private/stop",
        status: "stopped",
        updatedAt: "2026-05-06T06:00:00.000Z",
      },
    ],
    agents: [
      {
        agentId: "agent-error",
        objective: "Inspect failure",
        status: "error",
        activeSessionId: null,
        updatedAt: "2026-05-06T08:00:00.000Z",
      },
      {
        agentId: "agent-wait",
        objective: "Wait on operator",
        status: "running",
        activeSessionId: "session-wait",
        updatedAt: "2026-05-06T11:00:00.000Z",
      },
      {
        agentId: "agent-stopping",
        objective: "Stopping work",
        status: "stopping",
        activeSessionId: null,
        updatedAt: "2026-05-06T12:00:00.000Z",
      },
      {
        agentId: "agent-idle",
        objective: "Idle work",
        status: "idle",
        activeSessionId: null,
        updatedAt: "2026-05-06T10:00:00.000Z",
      },
      {
        agentId: "agent-run",
        objective: "Normal running work",
        status: "running",
        activeSessionId: "session-run",
        updatedAt: "2026-05-06T09:00:00.000Z",
      },
      {
        agentId: "agent-stopped",
        objective: "Finished work",
        status: "stopped",
        activeSessionId: null,
        updatedAt: "2026-05-06T07:30:00.000Z",
      },
    ],
    backgroundAgents: {
      agents: [
        {
          agentId: "agent-background",
          objective: "Background phone check",
          status: "running",
          activeSessionId: null,
          updatedAt: "2026-05-06T12:30:00.000Z",
        },
      ],
      nextCursor: "cursor-secret",
      starting: false,
      stoppingAgentIds: ["agent-stopping"],
      error: "background-error",
      updatedAt: "2026-05-06T12:30:00.000Z",
    },
    transcript: {
      agentId: "agent-wait",
      transcript: "full transcript secret with message.send",
      sessions: [
        {
          sessionId: "session-wait",
          itemCount: 9,
          transcript: "nested transcript secret",
          rolloutPath: "/private/rollout",
          source: "internal-source",
        },
      ],
      updatedAt: "2026-05-06T11:45:00.000Z",
    },
    composer: {
      sessionId: "session-wait",
      draft: "draft that must not leak",
      sending: false,
      lastMessageId: "message-secret",
      error: "composer-secret",
    },
  };
}

describe("AgenC portal mobile status contract", () => {
  it("projects ordered read-only check-ins with counts and attention flags", () => {
    const snapshot = createAgenCPortalMobileStatusSnapshot(
      createDashboardSnapshot(),
      {
        now: "2026-05-06T13:00:00.000Z",
        maxAgents: 3,
        maxSessions: 2,
      },
    );

    expect(snapshot).toMatchObject({
      protocolVersion: "0.4.0",
      generatedAt: "2026-05-06T13:00:00.000Z",
      connection: { status: "connected", initialized: true },
      auth: { authenticated: true },
      counts: {
        totalAgents: 7,
        totalSessions: 4,
        attentionAgents: 2,
        attentionSessions: 1,
        agents: {
          idle: 1,
          running: 3,
          stopping: 1,
          stopped: 1,
          error: 1,
        },
        sessions: {
          idle: 1,
          running: 1,
          waiting: 1,
          stopped: 1,
        },
      },
      truncated: { agents: true, sessions: true },
    });
    expect(snapshot.agents.map((agent) => agent.agentId)).toEqual([
      "agent-background",
      "agent-stopping",
      "agent-wait",
    ]);
    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
      "session-wait",
      "session-run",
    ]);
    expect(snapshot.agents[0]).toMatchObject({
      agentId: "agent-background",
      needsAttention: false,
      sessionTitle: null,
    });
    expect(snapshot.agents[1]).toMatchObject({
      agentId: "agent-stopping",
      needsAttention: false,
    });
    expect(snapshot.agents[2]).toMatchObject({
      agentId: "agent-wait",
      activeSessionId: "session-wait",
      sessionTitle: "Needs input",
      needsAttention: true,
    });
    expect(snapshot.sessions[0]).toMatchObject({
      sessionId: "session-wait",
      needsAttention: true,
    });
    expect(snapshot.sessions[1]).toMatchObject({
      sessionId: "session-run",
      needsAttention: false,
    });
  });

  it("normalizes limits and uses deterministic generatedAt values", () => {
    const dashboard = createDashboardSnapshot();
    const floored = createAgenCPortalMobileStatusSnapshot(dashboard, {
      maxAgents: 2.9,
      maxSessions: -1,
    });

    expect(floored.generatedAt).toBe("2026-05-06T10:00:00.000Z");
    expect(floored.agents.map((agent) => agent.agentId)).toEqual([
      "agent-background",
      "agent-stopping",
    ]);
    expect(floored.sessions).toEqual([]);
    expect(floored.truncated).toEqual({ agents: true, sessions: true });

    const fallbackLimits = createAgenCPortalMobileStatusSnapshot(dashboard, {
      maxAgents: Number.NaN,
      maxSessions: Number.POSITIVE_INFINITY,
    });
    expect(fallbackLimits.agents).toHaveLength(5);
    expect(fallbackLimits.sessions).toHaveLength(4);

    const disconnected = createAgenCPortalMobileStatusSnapshot({
      ...dashboard,
      connectionState: {
        ...dashboard.connectionState,
        updatedAt: null,
      },
    });
    expect(disconnected.generatedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("does not expose desktop workspace, auth identity, or transcript fields", () => {
    const snapshot = createAgenCPortalMobileStatusSnapshot(
      createDashboardSnapshot(),
      {
        maxAgents: 6,
        maxSessions: 4,
      },
    );

    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "agents",
        "auth",
        "connection",
        "counts",
        "generatedAt",
        "protocolVersion",
        "sessions",
        "truncated",
      ].sort(),
    );
    expect(Object.keys(snapshot.agents[0] ?? {}).sort()).toEqual(
      [
        "activeSessionId",
        "agentId",
        "needsAttention",
        "objective",
        "sessionTitle",
        "status",
        "updatedAt",
      ].sort(),
    );
    expect(Object.keys(snapshot.sessions[0] ?? {}).sort()).toEqual(
      [
        "agentId",
        "needsAttention",
        "sessionId",
        "status",
        "title",
        "updatedAt",
      ].sort(),
    );

    const serialized = JSON.stringify(snapshot);
    for (const denied of [
      "cwd",
      "/private",
      "accountId",
      "displayName",
      "urn:agenc:test:sensitive-identity",
      "draft",
      "message.send",
      "transcript",
      "rolloutPath",
      "source",
      "cursor-secret",
      "background-error",
      "composer-secret",
      "auth-secret",
    ]) {
      expect(serialized).not.toContain(denied);
    }
  });

  it("tie-breaks duplicate and default-truncated check-in rows deterministically", () => {
    const dashboard = {
      ...createDashboardSnapshot(),
      sessions: ["a", "b", "c", "d", "e", "f"].map((suffix) => ({
        sessionId: `session-${suffix}`,
        agentId: null,
        title: `Session ${suffix}`,
        cwd: `/private/${suffix}`,
        status: "running" as const,
        updatedAt: "2026-05-06T12:00:00.000Z",
      })),
      agents: [
        {
          agentId: "agent-a",
          objective: "Foreground A",
          status: "idle" as const,
          activeSessionId: null,
          updatedAt: "2026-05-06T12:00:00.000Z",
        },
        {
          agentId: "agent-b",
          objective: "Foreground B",
          status: "running" as const,
          activeSessionId: null,
          updatedAt: "2026-05-06T12:00:00.000Z",
        },
      ],
      backgroundAgents: {
        agents: ["a", "c", "d", "e", "f"].map((suffix) => ({
          agentId: `agent-${suffix}`,
          objective: `Background ${suffix}`,
          status: "running" as const,
          activeSessionId: null,
          updatedAt: "2026-05-06T12:00:00.000Z",
        })),
        nextCursor: null,
        starting: false,
        stoppingAgentIds: [],
        error: null,
        updatedAt: "2026-05-06T12:00:00.000Z",
      },
    } satisfies AgenCPortalDashboardSnapshot;

    const snapshot = createAgenCPortalMobileStatusSnapshot(dashboard);

    expect(snapshot.truncated).toEqual({ agents: true, sessions: true });
    expect(snapshot.agents.map((agent) => agent.agentId)).toEqual([
      "agent-a",
      "agent-b",
      "agent-c",
      "agent-d",
      "agent-e",
    ]);
    expect(snapshot.agents[0]?.objective).toBe("Foreground A");
    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
      "session-a",
      "session-b",
      "session-c",
      "session-d",
      "session-e",
    ]);
    expect(snapshot.counts.totalAgents).toBe(6);
    expect(snapshot.counts.agents).toEqual({
      idle: 1,
      running: 5,
      stopping: 0,
      stopped: 0,
      error: 0,
    });
  });
});
