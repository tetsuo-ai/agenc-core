import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";

describe("daemon runtime session binding", () => {
  it("rejects an unbound session alias across prompt, cancellation, mutation and snapshot routes", async () => {
    const sessions = new AgenCDaemonSessionManager();
    const bound = await sessions.createSession({ agentId: "agent", cwd: process.cwd() });
    const alias = await sessions.createSession({ agentId: "agent", cwd: process.cwd() });
    const submitAgentMessage = vi.fn().mockResolvedValue({
      disposition: "started", acceptedAt: "2026-09-10T00:00:00.000Z",
    });
    const interruptAgentTurn = vi.fn().mockResolvedValue(true);
    const clearAgentSession = vi.fn().mockResolvedValue({ cleared: true });
    const snapshotAgentSession = vi.fn().mockResolvedValue({ snapshot: true });
    const manager = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: vi.fn(), submitAgentMessage, interruptAgentTurn,
        clearAgentSession, snapshotAgentSession,
      },
    });
    await manager.restoreAgent({
      agentId: "agent", objective: "bound runtime", sessionIds: [bound.sessionId], runtimeAvailable: true,
    });
    const prompt = {
      content: "hello",
      messageId: "message", streamId: "stream", acceptedAt: "2026-09-10T00:00:00.000Z",
    };

    await expect(manager.streamAgentMessage({ ...prompt, sessionId: alias.sessionId }))
      .rejects.toMatchObject({ code: "AGENT_NOT_FOUND", message: expect.stringContaining("not bound") });
    await expect(manager.cancelSessionTurn({ sessionId: alias.sessionId }))
      .resolves.toMatchObject({ cancelled: false });
    await expect(manager.clearSessionHistory({ sessionId: alias.sessionId }))
      .rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    await expect(manager.snapshotSession({ sessionId: alias.sessionId }))
      .rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    for (const method of [submitAgentMessage, interruptAgentTurn, clearAgentSession, snapshotAgentSession]) {
      expect(method).not.toHaveBeenCalled();
    }

    await expect(manager.streamAgentMessage({ ...prompt, sessionId: bound.sessionId }))
      .resolves.toMatchObject({ disposition: "started" });
    await expect(manager.cancelSessionTurn({ sessionId: bound.sessionId }))
      .resolves.toMatchObject({ cancelled: true });
    await manager.clearSessionHistory({ sessionId: bound.sessionId });
    await manager.snapshotSession({ sessionId: bound.sessionId });
    for (const method of [submitAgentMessage, interruptAgentTurn, clearAgentSession, snapshotAgentSession]) {
      expect(method).toHaveBeenCalledOnce();
    }
  });
});
