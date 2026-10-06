import { afterEach, describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { crossProviderConsentAvailability } from "../../src/app-server/live-approval-broker.js";
import type { AgenCBackgroundAgentSnapshot } from "../../src/app-server/background-agent-runner.js";
import { AGENC_CROSS_PROVIDER_CONSENT_CAPABILITY, type JsonObject } from "../../src/app-server/protocol/index.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";

// The approval broker asks whether a person can answer consent by the owner's
// run id, which is the daemon agent id (the conversation id). Desktop attaches
// to that agent's daemon session, whose id differs. A live run was refused with
// consent_unavailable because the check looked up the run id as a session.

const dispatchers: AgenCDaemonJsonRpcDispatcher[] = [];
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
});

const SNAPSHOT: AgenCBackgroundAgentSnapshot = {
  status: "idle", lastActiveAt: "2026-09-23T00:00:00.000Z",
  runtimeSettingsEventId: "runtime-settings:conv-owner:1",
  runtimeSettings: {
    permissionMode: "default", prePlanMode: null, autoModeActive: false,
    autoModeAvailable: true, bypassPermissionsModeAvailable: false,
    bypassPermissionsWorkspace: null, bypassPermissionsConsentWorkspace: null,
    model: "grok-4.7", provider: "grok", profile: null, reasoningEffort: null,
    modelVerbosity: null, serviceTier: null, hooksDisabled: false,
  },
};

function request(id: string, method: string, params: JsonObject): JsonObject {
  return { jsonrpc: "2.0", id, method, params };
}

async function harness() {
  const sessions = new AgenCDaemonSessionManager();
  const session = await sessions.createSession({
    agentId: "conv-owner", cwd: process.cwd(),
    metadata: { runtimeOptions: resolveAgentRuntimeOptions({}) },
  });
  const agents = new AgenCDaemonAgentManager({
    sessionManager: sessions,
    runner: { startAgent: vi.fn(), getAgentSnapshot: vi.fn(async () => SNAPSHOT) },
  });
  await agents.restoreAgent({
    agentId: "conv-owner", objective: "orchestrate", sessionIds: [session.sessionId], runtimeAvailable: true,
  });
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager: agents, sessionManager: sessions, clientMultiplexer: multiplexer,
  });
  dispatchers.push(dispatcher);
  const canAnswer = crossProviderConsentAvailability({
    sessionIdsForAgent: (agentId) => agents.sessionIdsForAgent(agentId),
    hasAttachedClientWithCapability: (sessionId, capability) =>
      multiplexer.hasAttachedClientWithCapability(sessionId, capability),
  });
  const connect = async (capabilities: JsonObject) => {
    const connection = dispatcher.createConnection({ sendNotification: () => {} });
    await expect(connection.dispatch(request("init", "initialize", {
      protocol: { version: "1.9.0" }, capabilities,
    }))).resolves.toHaveProperty("result");
    return connection;
  };
  return { session, multiplexer, canAnswer, connect };
}

describe("cross-provider consent availability for a daemon agent", () => {
  it("finds a consent-capable client attached to the agent's daemon session", async () => {
    const h = await harness();
    expect(h.session.sessionId).not.toBe("conv-owner");
    expect(await h.canAnswer("conv-owner")).toBe(false);
    const desktop = await h.connect({ [AGENC_CROSS_PROVIDER_CONSENT_CAPABILITY]: true });
    await expect(desktop.dispatch(request("attach", "agent.attach", {
      agentId: "conv-owner", clientId: "agenc-sdk-4242-turn",
    }))).resolves.toHaveProperty("result");
    expect(await h.canAnswer("conv-owner")).toBe(true);
    // The old check looked the run id up as a session route; it has none.
    expect(await h.multiplexer.hasAttachedClientWithCapability("conv-owner", AGENC_CROSS_PROVIDER_CONSENT_CAPABILITY)).toBe(false);
    expect(await h.canAnswer("conv-other")).toBe(false);
    await desktop.close();
    expect(await h.canAnswer("conv-owner")).toBe(false);
  });

  it("stays unavailable when only a client without consent is attached", async () => {
    const h = await harness();
    const legacy = await h.connect({});
    await expect(legacy.dispatch(request("attach", "agent.attach", {
      agentId: "conv-owner", clientId: "legacy-client",
    }))).resolves.toHaveProperty("result");
    expect(await h.canAnswer("conv-owner")).toBe(false);
    await legacy.close();
  });
});
