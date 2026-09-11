import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { AgenCBackgroundAgentSnapshot } from "../../src/app-server/background-agent-runner.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";

describe("concurrent attachment adoption", () => {
  it("rejects an ordinary attachment revoked before its commit", async () => {
    const sessions = new AgenCDaemonSessionManager();
    const session = await sessions.createSession({ cwd: process.cwd() });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const acquire = sessions.attachSessionWithOwnership.bind(sessions);
    vi.spyOn(sessions, "attachSessionWithOwnership").mockImplementation(async (...args) => {
      const receipt = await acquire(...args);
      entered.resolve();
      await release.promise;
      return receipt;
    });
    const attaching = sessions.attachSession({ sessionId: session.sessionId, clientId: "client" });
    const rejected = expect(attaching).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    try {
      await entered.promise;
      await sessions.terminateSession({ sessionId: session.sessionId });
    } finally {
      release.resolve();
    }
    await rejected;
    expect((await sessions.getSession(session.sessionId))?.activeAttachmentIds).toBeUndefined();
  });

  it.each([
    { label: "successful agent.attach adopter", adopterMethod: "agent.attach", failureOrder: null, sameSession: true },
    { label: "successful session.attach adopter", adopterMethod: "session.attach", failureOrder: null, sameSession: true },
    { label: "successful different-session adopter", adopterMethod: "session.attach", failureOrder: null, sameSession: false },
    { label: "both fail, creator first", adopterMethod: "agent.attach", failureOrder: "creator", sameSession: true },
    { label: "both fail, adopter first", adopterMethod: "agent.attach", failureOrder: "adopter", sameSession: true },
  ] as const)(
    "settles shared attachment ownership: $label", async ({ adopterMethod, failureOrder, sameSession }) => {
      const sessions = new AgenCDaemonSessionManager();
      const session = await sessions.createSession({
        agentId: "agent", cwd: process.cwd(),
        metadata: { runtimeOptions: resolveAgentRuntimeOptions({}) },
      });
      const adopterSessionId = sameSession ? session.sessionId : (
        await sessions.createSession({ agentId: "other-agent", cwd: process.cwd() })
      ).sessionId;
      const snapshot: AgenCBackgroundAgentSnapshot = {
        status: "idle", lastActiveAt: "2026-09-11T00:00:00.000Z",
        runtimeSettingsEventId: "runtime-settings:agent:1",
        runtimeSettings: {
          permissionMode: "default", prePlanMode: null, autoModeActive: false,
          autoModeAvailable: true, bypassPermissionsModeAvailable: false,
          bypassPermissionsWorkspace: null, bypassPermissionsConsentWorkspace: null,
          model: "grok-5", provider: "grok", profile: null, reasoningEffort: null,
          modelVerbosity: null, serviceTier: null, hooksDisabled: false,
        },
      };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<AgenCBackgroundAgentSnapshot>();
      const adopterEntered = Promise.withResolvers<void>();
      const releaseAdopter = Promise.withResolvers<AgenCBackgroundAgentSnapshot>();
      let snapshotsRead = 0;
      const getAgentSnapshot = vi.fn(async () => {
        if (++snapshotsRead === 2) {
          entered.resolve();
          return release.promise;
        }
        if (snapshotsRead === 4 && failureOrder !== null) {
          adopterEntered.resolve();
          return releaseAdopter.promise;
        }
        return snapshot;
      });
      const agents = new AgenCDaemonAgentManager({
        sessionManager: sessions,
        runner: { startAgent: vi.fn(), getAgentSnapshot },
      });
      await agents.restoreAgent({
        agentId: "agent", objective: "adopt attachment", sessionIds: [session.sessionId], runtimeAvailable: true,
      });
      const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
      const dispatcher = new AgenCDaemonJsonRpcDispatcher({
        agentManager: agents, sessionManager: sessions, clientMultiplexer: multiplexer,
      });
      const send = vi.fn();
      const connection = dispatcher.createConnection({ sendNotification: send });
      let first: ReturnType<typeof connection.dispatch> | undefined;
      let adopter: ReturnType<typeof connection.dispatch> | undefined;
      try {
        await connection.dispatch({
          jsonrpc: "2.0", id: "initialize", method: "initialize", params: { protocol: { version: "1.9.0" } },
        });
        first = connection.dispatch({
          jsonrpc: "2.0", id: "creator", method: "agent.attach", params: { agentId: "agent", clientId: "client" },
        });
        await entered.promise;
        adopter = connection.dispatch({
          jsonrpc: "2.0", id: "adopter", method: adopterMethod,
          params: adopterMethod === "agent.attach"
            ? { agentId: "agent", clientId: "client" }
            : { sessionId: adopterSessionId, clientId: "client" },
        });
        if (failureOrder === null) await expect(adopter).resolves.toHaveProperty("result");
        else await adopterEntered.promise;
        const adopted = await sessions.getSession(adopterSessionId);
        if (failureOrder === "adopter") {
          releaseAdopter.resolve({ status: "idle", lastActiveAt: snapshot.lastActiveAt });
          await expect(adopter).resolves.toHaveProperty("error");
          expect((await sessions.getSession(session.sessionId))?.activeAttachmentIds)
            .toEqual(adopted?.activeAttachmentIds);
        }
        release.resolve({ status: "idle", lastActiveAt: snapshot.lastActiveAt });
        await expect(first).resolves.toHaveProperty("error");
        if (failureOrder === "creator") {
          expect((await sessions.getSession(session.sessionId))?.activeAttachmentIds)
            .toEqual(adopted?.activeAttachmentIds);
          releaseAdopter.resolve({ status: "idle", lastActiveAt: snapshot.lastActiveAt });
          await expect(adopter).resolves.toHaveProperty("error");
        }
        expect((await sessions.getSession(adopterSessionId))?.activeAttachmentIds)
          .toEqual(failureOrder === null ? adopted?.activeAttachmentIds : undefined);
        expect(await multiplexer.attachedClientIds(adopterSessionId))
          .toEqual(failureOrder === null ? ["client"] : []);
        if (!sameSession) {
          expect((await sessions.getSession(session.sessionId))?.activeAttachmentIds).toBeUndefined();
          expect(await multiplexer.attachedClientIds(session.sessionId)).toEqual([]);
        }
        const event = { type: "after_creator_rollback" };
        await multiplexer.broadcastSessionEvent(adopterSessionId, event);
        if (failureOrder === null) expect(send).toHaveBeenCalledExactlyOnceWith(event);
        else expect(send).not.toHaveBeenCalled();
      } finally {
        release.resolve(snapshot);
        releaseAdopter.resolve(snapshot);
        await first;
        await adopter;
        await dispatcher.close();
      }
    },
  );
});
