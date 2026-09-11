import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { AgenCBackgroundAgentSnapshot } from "../../src/app-server/background-agent-runner.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { drainMicrotasks } from "../helpers/controlled-async.js";

function request(id: string, method: string, params: JsonObject = {}): JsonObject {
  return { jsonrpc: "2.0", id, method, params: method === "initialize" ? { protocol: { version: "1.9.0" } } : params };
}

async function harness(runner?: ConstructorParameters<typeof AgenCDaemonAgentManager>[0]["runner"]) {
  const sessions = new AgenCDaemonSessionManager();
  const first = await sessions.createSession({
    agentId: "agent", cwd: process.cwd(), metadata: { runtimeOptions: resolveAgentRuntimeOptions({}) },
  });
  const second = await sessions.createSession({ agentId: "other-agent", cwd: process.cwd() });
  const agents = new AgenCDaemonAgentManager({ sessionManager: sessions, runner });
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: agents, sessionManager: sessions, clientMultiplexer: multiplexer });
  const send = vi.fn();
  const connection = dispatcher.createConnection({ sendNotification: send });
  await connection.dispatch(request("init", "initialize"));
  return { sessions, agents, multiplexer, dispatcher, connection, send, first, second };
}

describe("attachment registration concurrency", () => {
  it.each([false, true])("shares unresolved registration across simultaneous session attaches (different sessions: %s)", async (differentSessions) => {
    const h = await harness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = h.multiplexer.registerClient.bind(h.multiplexer);
    const register = vi.spyOn(h.multiplexer, "registerClient").mockImplementation(async (options) => {
      entered.resolve();
      await release.promise;
      return original(options);
    });
    const pending: Array<ReturnType<typeof h.connection.dispatch>> = [];
    try {
      pending.push(h.connection.dispatch(request("first", "session.attach", { sessionId: h.first.sessionId, clientId: "shared-client" })));
      await entered.promise;
      const secondSessionId = differentSessions ? h.second.sessionId : h.first.sessionId;
      pending.push(h.connection.dispatch(request("second", "session.attach", { sessionId: secondSessionId, clientId: "shared-client" })));
      await drainMicrotasks(12);
      expect(register).toHaveBeenCalledTimes(1);
      expect(h.connection.trackedClientIds).toEqual([]);
      release.resolve();
      const responses = await Promise.all(pending);
      for (const response of responses) expect(response).toHaveProperty("result");
      if (!differentSessions) {
        expect(responses[0]).toMatchObject({ result: { attachmentId: (responses[1] as { result: { attachmentId: string } }).result.attachmentId } });
      }
      expect(h.connection.trackedClientIds).toEqual(["shared-client"]);
      for (const sessionId of new Set([h.first.sessionId, secondSessionId])) {
        expect(await h.multiplexer.attachedClientIds(sessionId)).toEqual(["shared-client"]);
        expect((await h.sessions.getSession(sessionId))?.activeAttachmentIds).toHaveLength(1);
        await h.multiplexer.broadcastSessionEvent(sessionId, { type: "live_after_shared_registration" });
      }
      expect(h.send).toHaveBeenCalledTimes(differentSessions ? 2 : 1);
      await h.connection.close();
      expect(await h.multiplexer.attachedClientIds(h.first.sessionId)).toEqual([]);
      expect(await h.multiplexer.attachedClientIds(h.second.sessionId)).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      register.mockRestore();
      await h.connection.close();
      await h.dispatcher.close();
    }
  });

  it("does not remove a replacement connection when shared delayed registration finishes after close", async () => {
    const h = await harness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = h.multiplexer.registerClient.bind(h.multiplexer);
    const register = vi.spyOn(h.multiplexer, "registerClient").mockImplementationOnce(async (options) => {
      entered.resolve();
      await release.promise;
      return original(options);
    });
    const replacement = h.dispatcher.createConnection({ sendNotification: () => {} });
    const pending: Array<ReturnType<typeof h.connection.dispatch>> = [];
    try {
      pending.push(h.connection.dispatch(request("first", "session.attach", { sessionId: h.first.sessionId, clientId: "shared-client" })));
      await entered.promise;
      pending.push(h.connection.dispatch(request("second", "session.attach", { sessionId: h.second.sessionId, clientId: "shared-client" })));
      await drainMicrotasks(12);
      expect(register).toHaveBeenCalledTimes(1);
      await h.connection.close();
      await replacement.dispatch(request("replacement-init", "initialize"));
      await expect(replacement.dispatch(request("replacement-attach", "session.attach", { sessionId: h.first.sessionId, clientId: "shared-client" }))).resolves.toHaveProperty("result");
      release.resolve();
      for (const response of await Promise.all(pending)) expect(response).toHaveProperty("error");
      expect(await h.multiplexer.attachedClientIds(h.first.sessionId)).toEqual(["shared-client"]);
      expect((await h.sessions.getSession(h.first.sessionId))?.activeAttachmentIds).toHaveLength(1);
      expect(replacement.trackedClientIds).toEqual(["shared-client"]);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      register.mockRestore();
      await h.connection.close();
      await replacement.close();
      await h.dispatcher.close();
    }
  });

  it.each([false, true])("preserves a pending different-session attach while creator rollback runs (adopter fails: %s)", async (adopterFails) => {
    const snapshot: AgenCBackgroundAgentSnapshot = {
      status: "idle", lastActiveAt: "2026-09-11T00:00:00.000Z", runtimeSettingsEventId: "settings:1",
      runtimeSettings: {
        permissionMode: "default", prePlanMode: null, autoModeActive: false, autoModeAvailable: true,
        bypassPermissionsModeAvailable: false, bypassPermissionsWorkspace: null, bypassPermissionsConsentWorkspace: null,
        model: "grok-5", provider: "grok", profile: null, reasoningEffort: null, modelVerbosity: null, serviceTier: null, hooksDisabled: false,
      },
    };
    const snapshotEntered = Promise.withResolvers<void>();
    const snapshotRelease = Promise.withResolvers<AgenCBackgroundAgentSnapshot>();
    let reads = 0;
    const h = await harness({ startAgent: vi.fn(), getAgentSnapshot: async () => {
      if (++reads === 2) { snapshotEntered.resolve(); return snapshotRelease.promise; }
      return snapshot;
    } });
    await h.agents.restoreAgent({ agentId: "agent", objective: "attachment test", sessionIds: [h.first.sessionId], runtimeAvailable: true });
    const adopterEntered = Promise.withResolvers<void>();
    const adopterRelease = Promise.withResolvers<void>();
    const originalAttach = h.multiplexer.attachClientToSession.bind(h.multiplexer);
    const attach = vi.spyOn(h.multiplexer, "attachClientToSession").mockImplementation(async (...args) => {
      if (args[0] === h.second.sessionId) {
        adopterEntered.resolve();
        await adopterRelease.promise;
        if (adopterFails) throw new Error("adopter attach failed");
      }
      return originalAttach(...args);
    });
    const register = vi.spyOn(h.multiplexer, "registerClient");
    const pending: Array<ReturnType<typeof h.connection.dispatch>> = [];
    try {
      pending.push(h.connection.dispatch(request("creator", "agent.attach", { agentId: "agent", clientId: "shared-client" })));
      await snapshotEntered.promise;
      pending.push(h.connection.dispatch(request("adopter", "session.attach", { sessionId: h.second.sessionId, clientId: "shared-client" })));
      await adopterEntered.promise;
      snapshotRelease.resolve({ status: "idle", lastActiveAt: snapshot.lastActiveAt });
      await expect(pending[0]).resolves.toHaveProperty("error");
      expect(await h.multiplexer.attachedClientIds(h.first.sessionId)).toEqual([]);
      expect(h.connection.trackedClientIds).toEqual(["shared-client"]);
      adopterRelease.resolve();
      await expect(pending[1]).resolves.toHaveProperty(adopterFails ? "error" : "result");
      expect(await h.multiplexer.attachedClientIds(h.second.sessionId)).toEqual(adopterFails ? [] : ["shared-client"]);
      expect(h.connection.trackedClientIds).toEqual(adopterFails ? [] : ["shared-client"]);
      expect(register).toHaveBeenCalledTimes(1);
      if (adopterFails) {
        attach.mockRestore();
        await expect(h.connection.dispatch(request("retry", "session.attach", { sessionId: h.second.sessionId, clientId: "shared-client" }))).resolves.toHaveProperty("result");
        expect(register).toHaveBeenCalledTimes(2);
      }
    } finally {
      snapshotRelease.resolve(snapshot);
      adopterRelease.resolve();
      await Promise.allSettled(pending);
      attach.mockRestore();
      register.mockRestore();
      await h.connection.close();
      await h.dispatcher.close();
    }
  });
});
