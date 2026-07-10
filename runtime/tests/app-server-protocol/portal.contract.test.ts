import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_WEBSOCKET_DEFAULT_HOST,
  AGENC_DAEMON_WEBSOCKET_DEFAULT_PATH,
  AGENC_DAEMON_WEBSOCKET_DEFAULT_PORT,
} from "../app-server/daemon-cli.js";
import { isAgenCDaemonMethod } from "../app-server/protocol/index.js";
import {
  AGENC_PORTAL_CLIENT_CAPABILITIES,
  AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS,
  AGENC_PORTAL_AUTH_METHODS,
  AGENC_PORTAL_CONNECTION_STATUSES,
  AGENC_PORTAL_DAEMON_INITIALIZE_REQUEST,
  AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT,
  AGENC_PORTAL_DEFAULT_REMOTE_DAEMON_ENDPOINT,
  AGENC_PORTAL_DEFAULT_REQUEST_TIMEOUT_MS,
  AGENC_PORTAL_METHODS,
  AGENC_PORTAL_PROTOCOL_VERSION,
  createAgenCPortalAgentAttachRequest,
  createAgenCPortalAgentCreateRequest,
  createAgenCPortalAgentListRequest,
  createAgenCPortalAgentLogsRequest,
  createAgenCPortalAgentStopRequest,
  createAgenCPortalDaemonInitializeRequest,
  createAgenCPortalMessageSendRequest,
  createAgenCPortalSessionAttachRequest,
  isAgenCPortalAuthMethod,
  isAgenCPortalMethod,
  type AgenCPortalDashboardSnapshot,
} from "./index.js";

describe("AgenC portal protocol contract", () => {
  it("pins the workspace portal protocol version", () => {
    expect(AGENC_PORTAL_PROTOCOL_VERSION).toBe("0.4.0");
  });

  it("exposes only daemon methods that exist in the shared protocol", () => {
    expect(AGENC_PORTAL_METHODS).toEqual([
      "initialize",
      "health.ready",
      "health.stats",
      "auth.whoami",
      "auth.login",
      "auth.logout",
      "session.list",
      "session.attach",
      "agent.create",
      "agent.list",
      "agent.attach",
      "agent.stop",
      "agent.logs",
      "message.send",
    ]);
    expect(AGENC_PORTAL_METHODS.every(isAgenCDaemonMethod)).toBe(true);
  });

  it("guards portal method strings at runtime", () => {
    expect(isAgenCPortalMethod("agent.attach")).toBe(true);
    expect(isAgenCPortalMethod("agent.create")).toBe(true);
    expect(isAgenCPortalMethod("agent.stop")).toBe(true);
    expect(isAgenCPortalMethod("message.send")).toBe(true);
    expect(isAgenCPortalMethod("tool.approve")).toBe(false);
  });

  it("declares dashboard, auth, and background workspace capabilities needed by the sibling portal repo", () => {
    expect(AGENC_PORTAL_CLIENT_CAPABILITIES).toEqual([
      "portal.dashboard.read",
      "portal.mobile.status.read",
      "portal.mobile.status.push.v1",
      "portal.auth.read",
      "portal.auth.login",
      "portal.auth.logout",
      "portal.session.attach",
      "portal.agent.list",
      "portal.agent.start",
      "portal.agent.attach",
      "portal.agent.stop",
      "portal.transcript.read",
      "portal.message.send",
    ]);
    expect(AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS).toEqual({
      "portal.dashboard.read": true,
      "portal.mobile.status.read": true,
      "portal.mobile.status.push.v1": true,
      "portal.auth.read": true,
      "portal.auth.login": true,
      "portal.auth.logout": true,
      "portal.session.attach": true,
      "portal.agent.list": true,
      "portal.agent.start": true,
      "portal.agent.attach": true,
      "portal.agent.stop": true,
      "portal.transcript.read": true,
      "portal.message.send": true,
    });
    expect(AGENC_PORTAL_AUTH_METHODS).toEqual([
      "auth.whoami",
      "auth.login",
      "auth.logout",
    ]);
    expect(AGENC_PORTAL_AUTH_METHODS.every(isAgenCPortalAuthMethod)).toBe(true);
    expect(isAgenCPortalAuthMethod("auth.whoami")).toBe(true);
    expect(isAgenCPortalAuthMethod("tool.approve")).toBe(false);
  });

  it("pins the websocket daemon connection defaults", () => {
    expect(AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT).toBe(
      "ws://127.0.0.1:7766/",
    );
    const localUrl = new URL(AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT);
    expect(localUrl.hostname).toBe(AGENC_DAEMON_WEBSOCKET_DEFAULT_HOST);
    expect(Number(localUrl.port)).toBe(AGENC_DAEMON_WEBSOCKET_DEFAULT_PORT);
    expect(localUrl.pathname).toBe(AGENC_DAEMON_WEBSOCKET_DEFAULT_PATH);
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
    expect(createAgenCPortalDaemonInitializeRequest()).toEqual(
      AGENC_PORTAL_DAEMON_INITIALIZE_REQUEST,
    );
  });

  it("builds initialize requests with an optional daemon auth cookie", () => {
    expect(
      createAgenCPortalDaemonInitializeRequest("portal-cookie").params,
    ).toEqual({
      ...AGENC_PORTAL_DAEMON_INITIALIZE_REQUEST.params,
      authCookie: "portal-cookie",
    });
    expect(
      createAgenCPortalDaemonInitializeRequest(null).params,
    ).not.toHaveProperty("authCookie");
  });

  it("builds workspace requests for attach, transcripts, and messages", () => {
    expect(createAgenCPortalAgentListRequest({ limit: 20 }, "list-1")).toEqual({
      jsonrpc: "2.0",
      id: "list-1",
      method: "agent.list",
      params: { limit: 20 },
    });
    expect(
      createAgenCPortalAgentCreateRequest(
        {
          objective: "Run the background dashboard smoke test",
          cwd: "/workspace",
          initialContent: "Start from the portal dashboard",
          unattendedAllow: ["FileRead"],
          metadata: { source: "portal.dashboard" },
        },
        "start-1",
      ),
    ).toEqual({
      jsonrpc: "2.0",
      id: "start-1",
      method: "agent.create",
      params: {
        objective: "Run the background dashboard smoke test",
        cwd: "/workspace",
        initialContent: "Start from the portal dashboard",
        unattendedAllow: ["FileRead"],
        metadata: { source: "portal.dashboard" },
      },
    });
    expect(
      createAgenCPortalAgentCreateRequest({
        objective: "Start without optional metadata",
      }).params,
    ).not.toHaveProperty("metadata");
    expect(createAgenCPortalSessionAttachRequest("session-1")).toEqual({
      jsonrpc: "2.0",
      id: "session.attach",
      method: "session.attach",
      params: {
        sessionId: "session-1",
        clientId: "agenc-portal",
      },
    });
    expect(
      createAgenCPortalAgentAttachRequest("agent-1", "portal-tab-1", 7),
    ).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "agent.attach",
      params: {
        agentId: "agent-1",
        clientId: "portal-tab-1",
      },
    });
    expect(createAgenCPortalAgentLogsRequest("agent-1")).toEqual({
      jsonrpc: "2.0",
      id: "agent.logs",
      method: "agent.logs",
      params: { agentId: "agent-1" },
    });
    expect(
      createAgenCPortalAgentStopRequest(
        "agent-1",
        "portal dashboard stop",
        "stop-1",
      ),
    ).toEqual({
      jsonrpc: "2.0",
      id: "stop-1",
      method: "agent.stop",
      params: {
        agentId: "agent-1",
        reason: "portal dashboard stop",
      },
    });
    expect(
      createAgenCPortalMessageSendRequest(
        {
          sessionId: "session-1",
          content: "Continue",
          clientMessageId: "portal-message-1",
          metadata: { displayUserMessage: "Continue" },
        },
        "send-1",
      ),
    ).toEqual({
      jsonrpc: "2.0",
      id: "send-1",
      method: "message.send",
      params: {
        sessionId: "session-1",
        content: "Continue",
        clientMessageId: "portal-message-1",
        metadata: { displayUserMessage: "Continue" },
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
      auth: {
        authenticated: true,
        provider: "local",
        identity: {
          accountId: "local",
          displayName: "Local AgenC user",
          plan: "free",
        },
        error: null,
        updatedAt: "2026-05-06T00:00:00.000Z",
      },
      sessions: [
        {
          sessionId: "session-1",
          agentId: "agent-1",
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
      backgroundAgents: {
        agents: [
          {
            agentId: "agent-1",
            objective: "Finish WP-01",
            status: "running",
            activeSessionId: "session-1",
            updatedAt: "2026-05-06T00:00:00.000Z",
          },
        ],
        nextCursor: null,
        starting: false,
        stoppingAgentIds: [],
        error: null,
        updatedAt: "2026-05-06T00:00:00.000Z",
      },
      transcript: {
        agentId: "agent-1",
        transcript: "user\tContinue",
        sessions: [
          {
            sessionId: "session-1",
            itemCount: 1,
            transcript: "user\tContinue",
          },
        ],
        updatedAt: "2026-05-06T00:00:00.000Z",
      },
      composer: {
        sessionId: "session-1",
        draft: "Continue",
        sending: false,
        lastMessageId: null,
        error: null,
      },
    } satisfies AgenCPortalDashboardSnapshot;

    expect(snapshot.sessions[0]?.status).toBe("waiting");
    expect(snapshot.agents[0]?.activeSessionId).toBe("session-1");
    expect(snapshot.backgroundAgents.agents[0]?.status).toBe("running");
    expect(snapshot.backgroundAgents.stoppingAgentIds).toEqual([]);
    expect(snapshot.transcript?.sessions[0]?.itemCount).toBe(1);
    expect(snapshot.composer.sessionId).toBe("session-1");
    expect(snapshot.connectionState.initialized).toBe(true);
    expect(snapshot.auth.identity?.displayName).toBe("Local AgenC user");
  });
});
