import { describe, expect, it } from "vitest";
import { isAgenCDaemonMethod } from "../app-server/protocol/index.js";
import {
  AGENC_PORTAL_CLIENT_CAPABILITIES,
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
    expect(AGENC_PORTAL_METHODS).toContain("initialize");
    expect(AGENC_PORTAL_METHODS).toContain("session.list");
    expect(AGENC_PORTAL_METHODS).toContain("agent.list");
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
  });

  it("models the first dashboard snapshot without transport-specific state", () => {
    const snapshot = {
      protocolVersion: AGENC_PORTAL_PROTOCOL_VERSION,
      connection: null,
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
  });
});
