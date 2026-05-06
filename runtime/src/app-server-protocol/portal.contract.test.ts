import { describe, expect, it } from "vitest";
import { isAgenCDaemonMethod } from "../app-server/protocol/index.js";
import {
  AGENC_PORTAL_CLIENT_CAPABILITIES,
  AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS,
  AGENC_PORTAL_CONNECTION_STATUSES,
  AGENC_PORTAL_DAEMON_INITIALIZE_REQUEST,
  AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT,
  AGENC_PORTAL_DEFAULT_REMOTE_DAEMON_ENDPOINT,
  AGENC_PORTAL_DEFAULT_REQUEST_TIMEOUT_MS,
  AGENC_PORTAL_METHODS,
  AGENC_PORTAL_PROTOCOL_VERSION,
  isAgenCPortalMethod,
  type AgenCPortalDashboardSnapshot,
} from "./index.js";

describe("AgenC portal protocol contract", () => {
  it("pins the initial portal protocol version", () => {
    expect(AGENC_PORTAL_PROTOCOL_VERSION).toBe("0.1.0");
  });

  it("exposes only daemon methods that exist in the shared protocol", () => {
    expect(AGENC_PORTAL_METHODS).toEqual([
      "initialize",
      "health.ready",
      "health.stats",
      "auth.whoami",
      "session.list",
      "session.attach",
      "agent.list",
      "agent.attach",
    ]);
    expect(AGENC_PORTAL_METHODS.every(isAgenCDaemonMethod)).toBe(true);
  });

  it("guards portal method strings at runtime", () => {
    expect(isAgenCPortalMethod("agent.attach")).toBe(true);
    expect(isAgenCPortalMethod("tool.approve")).toBe(false);
  });

  it("declares dashboard capabilities needed by the sibling portal repo", () => {
    expect(AGENC_PORTAL_CLIENT_CAPABILITIES).toEqual([
      "portal.dashboard.read",
      "portal.session.attach",
      "portal.agent.attach",
    ]);
    expect(AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS).toEqual({
      "portal.dashboard.read": true,
      "portal.session.attach": true,
      "portal.agent.attach": true,
    });
  });

  it("pins the websocket daemon connection defaults", () => {
    expect(AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT).toBe(
      "ws://127.0.0.1:7766/",
    );
    expect(AGENC_PORTAL_DEFAULT_REMOTE_DAEMON_ENDPOINT).toBe(
      "wss://agenc.tech/daemon",
    );
    expect(AGENC_PORTAL_DEFAULT_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(AGENC_PORTAL_CONNECTION_STATUSES).toEqual([
      "disconnected",
      "connecting",
      "connected",
      "failed",
    ]);
  });

  it("publishes the initialize request the portal sends before dashboard reads", () => {
    expect(AGENC_PORTAL_DAEMON_INITIALIZE_REQUEST).toEqual({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "1.0.0",
        protocol: { version: "1.0.0" },
        clientName: "agenc-portal",
        capabilities: AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS,
      },
    });
  });

  it("models dashboard snapshots with websocket connection state", () => {
    const snapshot = {
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
        error: null,
        updatedAt: "2026-05-06T00:00:00.000Z",
      },
      sessions: [
        {
          sessionId: "session-1",
          title: "Investigate failing build",
          cwd: "/workspace",
          status: "waiting",
          updatedAt: "2026-05-06T00:00:00.000Z",
        },
      ],
      agents: [
        {
          agentId: "agent-1",
          objective: "Finish WP-01",
          status: "running",
          activeSessionId: "session-1",
          updatedAt: "2026-05-06T00:00:00.000Z",
        },
      ],
    } satisfies AgenCPortalDashboardSnapshot;

    expect(snapshot.sessions[0]?.status).toBe("waiting");
    expect(snapshot.agents[0]?.activeSessionId).toBe("session-1");
    expect(snapshot.connectionState.initialized).toBe(true);
  });
});
