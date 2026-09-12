import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "./protocol/index.js";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";

describe("daemon background process controls", () => {
  it("validates opaque task parameters before dispatching a stop", async () => {
    const stopSessionProcess = vi.fn(async () => ({ stopped: false }));
    const listSessionProcesses = vi.fn(async () => ({ processes: [] }));
    const connection = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { stopSessionProcess, listSessionProcesses } as never,
    }).createConnection();
    await connection.dispatch({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION } } });
    try {
      for (const params of [
        { sessionId: "s" }, { sessionId: "s", taskId: "" }, { sessionId: "s", taskId: 1 },
        { sessionId: "s", taskId: "x".repeat(129) }, { sessionId: "s", taskId: "opaque", ownerId: "foreign" },
      ]) {
        await expect(connection.dispatch({ jsonrpc: "2.0", id: "invalid", method: "session.processes.stop", params }))
          .resolves.toMatchObject({ error: { code: -32602 } });
      }
      expect(stopSessionProcess).not.toHaveBeenCalled();
      await expect(connection.dispatch({ jsonrpc: "2.0", id: "valid", method: "session.processes.stop", params: { sessionId: "s", taskId: "opaque" } }))
        .resolves.toMatchObject({ result: { stopped: false } });
      expect(stopSessionProcess).toHaveBeenCalledWith({ sessionId: "s", taskId: "opaque" });
    } finally {
      await connection.close();
    }
  });

  it("does not advertise missing implementations", async () => {
    const connection = new AgenCDaemonJsonRpcDispatcher({ agentManager: {} as never }).createConnection();
    try {
      const initialized = await connection.dispatch({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION } } });
      expect(initialized).toMatchObject({ result: { capabilities: { "daemon.methods": {
        "session.processes.list": false, "session.processes.stop": false,
      } } } });
      await expect(connection.dispatch({ jsonrpc: "2.0", id: "list", method: "session.processes.list", params: { sessionId: "s" } }))
        .resolves.toMatchObject({ error: { code: -32601 } });
    } finally {
      await connection.close();
    }
  });

  it("keeps new process controls unavailable to older protocol clients", async () => {
    const stopSessionProcess = vi.fn(async () => ({ stopped: true }));
    const connection = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { stopSessionProcess, listSessionProcesses: async () => ({ processes: [] }) } as never,
    }).createConnection();
    try {
      const initialized = await connection.dispatch({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocol: { version: "1.12.0" } } });
      expect(initialized).toMatchObject({ result: { capabilities: { "daemon.methods": {
        "session.processes.list": false, "session.processes.stop": false,
      } } } });
      await expect(connection.dispatch({ jsonrpc: "2.0", id: "stop", method: "session.processes.stop", params: { sessionId: "s", taskId: "opaque" } }))
        .resolves.toMatchObject({ error: { code: -32601 } });
      expect(stopSessionProcess).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it.each(["absent", "closed", "recovered"])("never starts a runtime while inspecting a %s session", async (state) => {
    const sessions = new AgenCDaemonSessionManager();
    const timestamp = "2026-09-11T12:00:00.000Z";
    const startAgent = vi.fn();
    const listAgentSessionProcesses = vi.fn(async () => ({ processes: [] }));
    const stopAgentSessionProcess = vi.fn(async () => ({ stopped: true }));
    const agents = new AgenCDaemonAgentManager({ sessionManager: sessions, runner: {
      startAgent, listAgentSessionProcesses, stopAgentSessionProcess,
    } });
    if (state !== "absent") {
      await sessions.restoreSession({ sessionId: "s", agentId: "a", status: "waiting", createdAt: timestamp });
      await agents.restoreAgent({ agentId: "a", objective: "passive", startedAt: timestamp, lastActiveAt: timestamp,
        sessionIds: ["s"], runtimeAvailable: state !== "recovered" });
      if (state === "closed") await sessions.terminateSession({ sessionId: "s" });
    }
    await expect(agents.listSessionProcesses({ sessionId: "s" })).rejects.toThrow();
    await expect(agents.stopSessionProcess({ sessionId: "s", taskId: "opaque" })).rejects.toThrow();
    expect(startAgent).not.toHaveBeenCalled();
    expect(listAgentSessionProcesses).not.toHaveBeenCalled();
    expect(stopAgentSessionProcess).not.toHaveBeenCalled();
  });

  it("reaches the process owner without waiting on a diagnostic snapshot", async () => {
    const sessions = new AgenCDaemonSessionManager();
    const timestamp = "2026-09-11T12:00:00.000Z";
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const getAgentSnapshot = vi.fn(async () => { await snapshotGate; return undefined; });
    const listAgentSessionProcesses = vi.fn(async () => ({ processes: [] }));
    const stopAgentSessionProcess = vi.fn(async () => ({ stopped: true }));
    const agents = new AgenCDaemonAgentManager({ sessionManager: sessions, runner: {
      startAgent: vi.fn(), getAgentSnapshot, listAgentSessionProcesses, stopAgentSessionProcess,
    } });
    await sessions.restoreSession({ sessionId: "s", agentId: "a", status: "waiting", createdAt: timestamp });
    await agents.restoreAgent({ agentId: "a", objective: "passive", startedAt: timestamp, lastActiveAt: timestamp,
      sessionIds: ["s"], runtimeAvailable: true });
    const stopping = agents.stopSessionProcess({ sessionId: "s", taskId: "opaque" });
    const listing = agents.listSessionProcesses({ sessionId: "s" });
    try {
      await vi.waitFor(() => expect(stopAgentSessionProcess).toHaveBeenCalledWith("a", "opaque"));
      await expect(stopping).resolves.toEqual({ stopped: true });
      await expect(listing).resolves.toEqual({ processes: [] });
      expect(getAgentSnapshot).not.toHaveBeenCalled();
    } finally {
      releaseSnapshot();
      await Promise.allSettled([stopping, listing]);
    }
  });
});
