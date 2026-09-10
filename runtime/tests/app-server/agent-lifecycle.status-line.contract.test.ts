import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";

async function createOwner(runtimeAvailable = true, closed = false) {
  const sessions = new AgenCDaemonSessionManager();
  const timestamp = "2026-09-10T12:00:00.000Z";
  await sessions.restoreSession({
    sessionId: "owner-session", agentId: "owner-agent", status: "waiting",
    createdAt: timestamp, initialPrompt: "deferred status line",
  });
  const executeAgentStatusLine = vi.fn(async () => ({ status: "rendered" as const, text: "owner" }));
  const startAgent = vi.fn(async () => ({
    agentId: "unused", startedAt: timestamp, status: "running" as const,
  }));
  const agents = new AgenCDaemonAgentManager({
    sessionManager: sessions,
    runner: { startAgent, executeAgentStatusLine },
  });
  await agents.restoreAgent({
    agentId: "owner-agent", objective: "deferred status line",
    startedAt: timestamp, lastActiveAt: timestamp,
    sessionIds: ["owner-session"], runtimeAvailable,
  });
  if (closed) await sessions.terminateSession({ sessionId: "owner-session" });
  return { agents, executeAgentStatusLine, startAgent };
}

describe("status line daemon session ownership", () => {
  it("routes to the exact owner without starting a turn", async () => {
    const { agents, executeAgentStatusLine, startAgent } = await createOwner();
    const params = { sessionId: "owner-session", presentation: { vimMode: "INSERT" as const } };
    const controller = new AbortController();
    await expect(agents.executeSessionStatusLine(params, controller.signal)).resolves.toEqual({
      status: "rendered", text: "owner",
    });
    expect(executeAgentStatusLine).toHaveBeenCalledWith("owner-agent", params, controller.signal);
    expect(startAgent).not.toHaveBeenCalled();
  });

  it.each([
    { runtimeAvailable: false, closed: false, sessionId: "owner-session" },
    { runtimeAvailable: true, closed: true, sessionId: "owner-session" },
    { runtimeAvailable: true, closed: false, sessionId: "different-session" },
  ])("rejects absent, closed and recovered-only owners: %j", async (state) => {
    const { agents, executeAgentStatusLine, startAgent } = await createOwner(state.runtimeAvailable, state.closed);
    await expect(agents.executeSessionStatusLine({ sessionId: state.sessionId })).rejects.toThrow();
    expect(executeAgentStatusLine).not.toHaveBeenCalled();
    expect(startAgent).not.toHaveBeenCalled();
  });
});
