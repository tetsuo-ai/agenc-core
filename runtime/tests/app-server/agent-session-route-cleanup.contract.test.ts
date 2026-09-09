import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import {
  AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
  type JsonObject,
  type SessionTerminateParams,
} from "../../src/app-server/protocol/index.js";

const workspaces = createTempWorkspaceFixture("agenc-agent-session-routes-");
const OWNED_SESSIONS = ["session_first", "session_second"] as const;
const CAPABILITY = "test.action";
const NOW = "2026-09-09T00:00:00.000Z";
type StopPath = "agent.stop" | "runner terminal" | "stopAll" | "stale reaping";
const STOP_PATHS: readonly StopPath[] = ["agent.stop", "runner terminal", "stopAll", "stale reaping"];

afterEach(async () => { await workspaces.cleanup(); });

async function createComposition(path: StopPath, onSessionTerminated?: (sessionId: string) => void) {
  const cwd = await workspaces.create();
  const sessions = new AgenCDaemonSessionManager({ now: () => NOW, onSessionTerminated });
  const multiplexer = new AgenCDaemonClientMultiplexer({
    sessionManager: sessions,
    maxBufferedEventsPerSession: 3,
  });
  const agents = new AgenCDaemonAgentManager({
    agencHome: cwd,
    sessionManager: sessions,
    terminateSession: (params: SessionTerminateParams) => multiplexer.terminateSession(params),
    now: () => NOW,
    runner: {
      startAgent: async () => ({ agentId: "agent_owner", startedAt: NOW, status: "running" }),
      stopAgent: async () => {},
      getAgentSnapshot: async () => path === "stale reaping" ? null : { status: "idle", lastActiveAt: NOW },
    },
    broadcastSessionEvent: async (sessionId, event) => { await multiplexer.broadcastSessionEvent(sessionId, event); },
  });
  for (const sessionId of [...OWNED_SESSIONS, "session_unrelated"]) {
    await sessions.restoreSession({ sessionId, agentId: "agent_owner", status: "idle", createdAt: NOW, cwd });
  }
  await agents.restoreAgent({
    agentId: "agent_owner", objective: "test owned sessions", status: "idle",
    sessionIds: [...OWNED_SESSIONS], runtimeAvailable: path !== "stale reaping", cwd,
  });
  const sends = [vi.fn(), vi.fn()];
  for (const [index, send] of sends.entries()) {
    const clientId = `client_${index}`;
    await multiplexer.registerClient({ clientId, send });
    for (const sessionId of OWNED_SESSIONS) await multiplexer.attachClientToSession(sessionId, clientId);
  }
  for (const sessionId of [...OWNED_SESSIONS, "session_unrelated"]) {
    await multiplexer.broadcastCapabilityEvent(sessionId, CAPABILITY, { sessionId, type: "buffered-action" });
  }
  const stop = async () => {
    if (path === "agent.stop") return agents.stopAgent({ agentId: "agent_owner" });
    if (path === "runner terminal") return agents.handleRunnerTerminated("agent_owner", { status: "stopped", lastActiveAt: NOW });
    if (path === "stopAll") return agents.stopAll();
    return agents.reapStaleAgents();
  };
  return { agents, sessions, multiplexer, sends, stop };
}

async function expectRoutesCleaned(fixture: Awaited<ReturnType<typeof createComposition>>) {
  const { sessions, multiplexer, sends } = fixture;
  for (const sessionId of OWNED_SESSIONS) {
    expect(await sessions.getSession(sessionId)).toMatchObject({ status: "closed" });
    expect(await multiplexer.attachedClientIds(sessionId)).toEqual([]);
  }
  const deliveryCounts = sends.map((send) => send.mock.calls.length);
  for (const sessionId of OWNED_SESSIONS) {
    for (let sequence = 0; sequence < 5; sequence += 1) {
      const event = { type: "late-event", sequence };
      expect(await multiplexer.broadcastSessionEvent(sessionId, event)).toEqual({ sessionId, deliveredClientIds: [], failed: [] });
      expect(await multiplexer.broadcastCapabilityEvent(sessionId, CAPABILITY, event)).toEqual({ sessionId, deliveredClientIds: [], failed: [] });
    }
  }
  expect(sends.map((send) => send.mock.calls.length)).toEqual(deliveryCounts);

  const capabilitySend = vi.fn();
  await multiplexer.registerClient({
    clientId: "capability_client", send: capabilitySend, capabilities: { [CAPABILITY]: true },
  });
  expect(capabilitySend).toHaveBeenCalledExactlyOnceWith({ sessionId: "session_unrelated", type: "buffered-action" });
  const statusSend = vi.fn();
  await multiplexer.registerClient({
    clientId: "status_client", send: statusSend,
    capabilities: { [AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY]: true },
  });
  expect(statusSend).not.toHaveBeenCalled();
  for (const sessionId of OWNED_SESSIONS) {
    const event: JsonObject = { method: "event.agent_status", params: { sessionId, status: "stopped" } };
    expect(await multiplexer.broadcastSessionEvent(sessionId, event)).toEqual({ sessionId, deliveredClientIds: [], failed: [] });
    expect(await multiplexer.broadcastCapabilityEvent(sessionId, CAPABILITY, event)).toEqual({ sessionId, deliveredClientIds: [], failed: [] });
    expect(await multiplexer.terminateSession({ sessionId })).toMatchObject({ terminated: false, status: "closed" });
  }
  expect(statusSend).not.toHaveBeenCalled();
  expect(capabilitySend).toHaveBeenCalledTimes(1);
  const detach = vi.spyOn(sessions, "detachSession");
  expect(await multiplexer.disconnectClient("client_0")).toEqual([]);
  expect(await multiplexer.disconnectClient("client_1")).toEqual([]);
  expect(detach).not.toHaveBeenCalled();
  await multiplexer.broadcastCapabilityEvent("session_unrelated", CAPABILITY, { type: "still-live" });
  expect(capabilitySend).toHaveBeenLastCalledWith({ type: "still-live" });
}

describe("agent-owned session route cleanup", () => {
  it("cleans the session route when agent creation rolls back after attachment", async () => {
    const cwd = await workspaces.create();
    const sessions = new AgenCDaemonSessionManager({ createSessionId: () => "session_rollback" });
    const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
    const send = vi.fn();
    await multiplexer.registerClient({ clientId: "client_rollback", send });
    const agents = new AgenCDaemonAgentManager({
      agencHome: cwd,
      sessionManager: sessions,
      terminateSession: (params) => multiplexer.terminateSession(params),
      runner: {
        startAgent: async () => ({ agentId: "agent_rollback", startedAt: NOW, status: "running" }),
        stopAgent: async () => {},
        attachAgentSessionEvents: async (_agentId, binding) => {
          await multiplexer.attachClientToSession(binding.sessionId, "client_rollback");
          await multiplexer.broadcastCapabilityEvent(binding.sessionId, CAPABILITY, { type: "pending" });
          throw new Error("runner event attachment failed");
        },
      },
    });
    await expect(agents.createAgent({
      cwd, objective: "rollback route cleanup", runtimeOptions: resolveAgentRuntimeOptions({}),
    })).rejects.toThrow("runner event attachment failed");
    expect(await sessions.getSession("session_rollback")).toMatchObject({ status: "closed" });
    expect(await multiplexer.attachedClientIds("session_rollback")).toEqual([]);
    expect(await multiplexer.disconnectClient("client_rollback")).toEqual([]);
    await multiplexer.registerClient({ clientId: "late_client", send, capabilities: { [CAPABILITY]: true } });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(STOP_PATHS)("cleans routes, reverse attachments and capability buffers through %s", async (path) => {
    const fixture = await createComposition(path);
    await fixture.stop();
    await expectRoutesCleaned(fixture);
    await expect(fixture.agents.stopAgent({ agentId: "agent_owner" })).resolves.toMatchObject({ stopped: false });
  });

  it.each(STOP_PATHS)("cleans all owned sessions when a post-termination hook fails through %s", async (path) => {
    const failure = new Error("session termination hook failed");
    const fixture = await createComposition(path, (sessionId) => {
      if (sessionId === OWNED_SESSIONS[0]) throw failure;
    });
    await expect(fixture.stop()).rejects.toThrow();
    await expectRoutesCleaned(fixture);
  });

  it("preserves live routing when termination fails before closing and permits a retry", async () => {
    const fixture = await createComposition("agent.stop");
    const failure = new Error("termination admission failed");
    const terminate = vi.spyOn(fixture.sessions, "terminateSession").mockRejectedValueOnce(failure);
    await expect(fixture.multiplexer.terminateSession({ sessionId: OWNED_SESSIONS[0] })).rejects.toBe(failure);
    expect(await fixture.multiplexer.attachedClientIds(OWNED_SESSIONS[0])).toEqual(["client_0", "client_1"]);
    expect(await fixture.sessions.getSession(OWNED_SESSIONS[0])).toMatchObject({ status: "idle" });
    terminate.mockRestore();
    await fixture.stop();
    await expectRoutesCleaned(fixture);
  });

  it("preserves the termination error and live route if the liveness lookup also fails", async () => {
    const fixture = await createComposition("agent.stop");
    const failure = new Error("termination admission failed");
    const terminate = vi.spyOn(fixture.sessions, "terminateSession").mockRejectedValueOnce(failure);
    const lookup = vi.spyOn(fixture.sessions, "getSession").mockRejectedValueOnce(new Error("lookup failed"));
    await expect(fixture.multiplexer.terminateSession({ sessionId: OWNED_SESSIONS[0] })).rejects.toBe(failure);
    expect(await fixture.multiplexer.attachedClientIds(OWNED_SESSIONS[0])).toEqual(["client_0", "client_1"]);
    terminate.mockRestore();
    lookup.mockRestore();
    await fixture.stop();
    await expectRoutesCleaned(fixture);
  });

  it("reports every post-close hook error after cleaning every owned session", async () => {
    const fixture = await createComposition("agent.stop", (sessionId) => {
      throw new Error(`hook failed for ${sessionId}`);
    });
    await expect(fixture.stop()).rejects.toMatchObject({
      errors: OWNED_SESSIONS.map((sessionId) => new Error(`hook failed for ${sessionId}`)),
    });
    await expectRoutesCleaned(fixture);
  });
});
