import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { AgenCBackgroundAgentSnapshot } from "../../src/app-server/background-agent-runner.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";

/*
 * A daemon restart restores every recovered run's agent and session records,
 * but a run whose provider needs a credential only its client holds cannot get
 * its runtime back at startup (restore materializes only the retained PATH).
 * Such an agent is "recovered without a live runtime" until a client resumes
 * it. agent.attach must say so the way every other live-runtime request does,
 * or clients cannot tell "resume me" apart from a bad request.
 */
const agentId = "conv-recovered-attach";
const sessionId = "session_recovered-attach";
const runtimeOptions = resolveAgentRuntimeOptions({});
const liveSnapshot: AgenCBackgroundAgentSnapshot = {
  status: "idle",
  lastActiveAt: "2026-09-22T16:04:44.000Z",
  runtimeSettingsEventId: "run-runtime-settings:conv-recovered-attach:1:revived",
  runtimeSettings: {
    permissionMode: "bypassPermissions", prePlanMode: null, autoModeActive: false,
    autoModeAvailable: false, bypassPermissionsModeAvailable: true,
    bypassPermissionsWorkspace: process.cwd(), bypassPermissionsConsentWorkspace: process.cwd(),
    model: "deepseek-flash", provider: "deepseek", profile: null, reasoningEffort: "high",
    modelVerbosity: null, serviceTier: null, hooksDisabled: false,
  },
};

async function restartedDaemon() {
  const sessions = new AgenCDaemonSessionManager();
  // What hydrateAgenCDaemonStartupRecovery publishes when restoreRecoveredAgentRuntime
  // reports the runtime unavailable: the session and agent records, no runtime.
  await sessions.restoreSession({
    sessionId, agentId, status: "waiting", cwd: process.cwd(),
    createdAt: "2026-09-22T16:03:07.166Z", initialPrompt: "Interactive session",
    metadata: { runtimeOptions },
  });
  const getAgentSnapshot = vi.fn<(id: string) => Promise<AgenCBackgroundAgentSnapshot | null>>(async () => null);
  const listPermissions = vi.fn(async () => ({ permissions: [] }));
  const agents = new AgenCDaemonAgentManager({
    sessionManager: sessions,
    runner: { startAgent: vi.fn(), getAgentSnapshot, listPermissions },
  });
  await agents.restoreAgent({
    agentId, objective: "Interactive session", status: "idle", cwd: process.cwd(),
    startedAt: "2026-09-22T16:03:07.166Z", lastActiveAt: "2026-09-22T16:04:44.000Z",
    sessionIds: [sessionId], runtimeAvailable: false,
  });
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager: agents, sessionManager: sessions, clientMultiplexer: multiplexer,
  });
  const connection = dispatcher.createConnection({ sendNotification: vi.fn() });
  let id = 0;
  const call = (method: string, params: JsonObject) =>
    connection.dispatch({ jsonrpc: "2.0", id: `request-${++id}`, method, params });
  await call("initialize", { protocol: { version: "1.9.0" } });
  return { sessions, agents, dispatcher, call, getAgentSnapshot };
}

describe("agent.attach after a daemon restart", () => {
  it("reports a recovered agent without a live runtime as resumable, before opening an attachment", async () => {
    const daemon = await restartedDaemon();
    try {
      // History stays reachable: the restored session record attaches.
      await expect(daemon.call("session.attach", { sessionId, clientId: "desktop-history" }))
        .resolves.toHaveProperty("result");
      const attachmentsAfterHistory = (await daemon.sessions.getSession(sessionId))?.activeAttachmentIds;
      const openAttachment = vi.spyOn(daemon.sessions, "attachSessionWithOwnership");

      const attached = await daemon.call("agent.attach", { agentId, clientId: "desktop-turn" });
      expect(attached).toMatchObject({
        error: {
          message: `AgenC daemon agent recovered without a live runtime: ${agentId}`,
          data: { code: "BACKGROUND_RUNNER_UNAVAILABLE" },
        },
      });
      // The same classification every other live-runtime request already uses.
      await expect(daemon.call("permission.list", { sessionId })).resolves.toMatchObject({
        error: {
          message: `AgenC daemon agent recovered without a live runtime: ${agentId}`,
          data: { code: "BACKGROUND_RUNNER_UNAVAILABLE" },
        },
      });
      // Refused before an attachment was opened (and had to be rolled back).
      expect(openAttachment).not.toHaveBeenCalled();
      expect((await daemon.sessions.getSession(sessionId))?.activeAttachmentIds)
        .toEqual(attachmentsAfterHistory);
    } finally {
      await daemon.dispatcher.close();
    }
  });

  it("attaches with the revived runtime's settings once a client resume restored it", async () => {
    const daemon = await restartedDaemon();
    try {
      await expect(daemon.call("agent.attach", { agentId, clientId: "desktop-turn" }))
        .resolves.toMatchObject({ error: { data: { code: "BACKGROUND_RUNNER_UNAVAILABLE" } } });
      // An explicit resume (agent.create with resumeSessionId) puts a live
      // generation in the runner; the lifecycle adopts it on the next read.
      daemon.getAgentSnapshot.mockResolvedValue(liveSnapshot);
      await expect(daemon.call("agent.attach", { agentId, clientId: "desktop-turn" })).resolves.toMatchObject({
        result: {
          agentId,
          sessionIds: [sessionId],
          runtimeSettingsEventId: liveSnapshot.runtimeSettingsEventId,
          runtimeSettings: { provider: "deepseek", reasoningEffort: "high" },
        },
      });
    } finally {
      await daemon.dispatcher.close();
    }
  });
});
