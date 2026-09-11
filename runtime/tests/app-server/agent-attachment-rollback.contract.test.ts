import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { AgenCBackgroundAgentSnapshot } from "../../src/app-server/background-agent-runner.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";

describe("agent attachment rollback ownership", () => {
  it.each([false, true])(
    "releases only attachment resources created by a failed request (previous attachment: %s)",
    async (previousAttachment) => {
      const sessions = new AgenCDaemonSessionManager();
      const session = await sessions.createSession({
        agentId: "agent", cwd: process.cwd(),
        metadata: { runtimeOptions: resolveAgentRuntimeOptions({}) },
      });
      const snapshot: AgenCBackgroundAgentSnapshot = {
        status: "idle", lastActiveAt: "2026-09-10T00:00:00.000Z",
        runtimeSettingsEventId: "runtime-settings:agent:1",
        runtimeSettings: {
          permissionMode: "default", prePlanMode: null, autoModeActive: false,
          autoModeAvailable: true, bypassPermissionsModeAvailable: false,
          bypassPermissionsWorkspace: null, bypassPermissionsConsentWorkspace: null,
          model: "grok-5", provider: "grok", profile: null, reasoningEffort: null,
          modelVerbosity: null, serviceTier: null, hooksDisabled: false,
        },
      };
      const getAgentSnapshot = vi.fn<() => Promise<AgenCBackgroundAgentSnapshot>>(async () => snapshot);
      const agents = new AgenCDaemonAgentManager({
        sessionManager: sessions,
        runner: { startAgent: vi.fn(), getAgentSnapshot },
      });
      await agents.restoreAgent({
        agentId: "agent", objective: "attachment rollback", sessionIds: [session.sessionId], runtimeAvailable: true,
      });
      const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
      const dispatcher = new AgenCDaemonJsonRpcDispatcher({
        agentManager: agents, sessionManager: sessions, clientMultiplexer: multiplexer,
      });
      const send = vi.fn();
      const connection = dispatcher.createConnection({ sendNotification: send });
      const attach = (id: string) => connection.dispatch({
        jsonrpc: "2.0", id, method: "agent.attach", params: { agentId: "agent", clientId: "client" },
      });
      try {
        await connection.dispatch({
          jsonrpc: "2.0", id: "initialize", method: "initialize", params: { protocol: { version: "1.9.0" } },
        });
        if (previousAttachment) await expect(attach("initial")).resolves.toHaveProperty("result");
        const original = await sessions.getSession(session.sessionId);
        getAgentSnapshot.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
          status: "idle", lastActiveAt: snapshot.lastActiveAt,
        });
        await expect(attach("failed")).resolves.toMatchObject({
          error: { message: expect.stringContaining("no live runtime-settings authority") },
        });
        const current = await sessions.getSession(session.sessionId);
        expect(current?.activeAttachmentIds).toEqual(original?.activeAttachmentIds);
        expect(await multiplexer.attachedClientIds(session.sessionId))
          .toEqual(previousAttachment ? ["client"] : []);
        const event = { type: "after_failed_attach" };
        await multiplexer.broadcastSessionEvent(session.sessionId, event);
        if (previousAttachment) expect(send).toHaveBeenCalledExactlyOnceWith(event);
        else expect(send).not.toHaveBeenCalled();
      } finally {
        await dispatcher.close();
      }
    },
  );
});
