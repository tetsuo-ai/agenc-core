import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createConnectedAgenCJsonLineDaemonTuiClient } from "../../src/app-server/agent-cli.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";
import { AgenCUnixSocketServer } from "../../src/app-server/transport/unix-socket.js";
import { createDaemonTuiSessionFixture } from "../helpers/daemon-tui-session.js";

it("refreshes advertised process capabilities after reconnect and clears them on close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenc-tui-process-capabilities-"));
  const socketPath = join(dir, "daemon.sock");
  let generation = 0;
  let disconnect = () => {};
  const server = new AgenCUnixSocketServer({
    socketPath,
    onMessage: async (message, context) => {
      if (message.method === "initialize") {
        generation += 1;
        disconnect = () => context.close();
        await context.send({ jsonrpc: "2.0", id: message.id, result: {
          type: "initialized", protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
          capabilities: { "daemon.methods": {
            "session.processes.list": generation === 1,
            "session.processes.stop": generation === 2,
          } },
        } });
      } else if (message.method === "session.processes.list") {
        await context.send(generation === 1
          ? { jsonrpc: "2.0", id: message.id, result: { processes: [] } }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method unavailable" } });
      } else {
        await context.send({ jsonrpc: "2.0", id: message.id, result: { agents: [] } });
      }
    },
  });
  await server.listen();
  const client = await createConnectedAgenCJsonLineDaemonTuiClient({ socketPath, authCookie: "test-cookie" });
  const session = createDaemonTuiSessionFixture({
    baseSession: { conversationId: "session", services: {} }, sessionId: "session", clientId: "tui",
    client: {
      request: client.request,
      supportsMethod: client.supportsMethod,
      subscribeToSessionEvents: client.subscribeToSessionEvents,
    },
  });
  try {
    expect(client.supportsMethod?.("session.processes.list")).toBe(true);
    expect(client.supportsMethod?.("session.processes.stop")).toBe(false);
    expect(await session.listDaemonSessionProcesses?.()).toEqual({ processes: [] });
    disconnect();
    await vi.waitFor(() => expect(client.getConnectionState().status).toBe("disconnected"));
    // A poll can start with the previous handshake's capability, then connect
    // to a daemon that no longer provides the method. Treat it as unavailable.
    expect(await session.listDaemonSessionProcesses?.()).toBeUndefined();
    expect(generation).toBe(2);
    expect(client.supportsMethod?.("session.processes.list")).toBe(false);
    expect(client.supportsMethod?.("session.processes.stop")).toBe(true);
  } finally {
    await client.close();
    expect(client.supportsMethod?.("session.processes.stop")).toBe(false);
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("explains unavailable process stops after reconnect without claiming a successful stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenc-review-stop-reconnect-"));
  const socketPath = join(dir, "daemon.sock");
  let generation = 0;
  let disconnect = () => {};
  const stopGenerations: number[] = [];
  const server = new AgenCUnixSocketServer({
    socketPath,
    onMessage: async (message, context) => {
      if (message.method === "initialize") {
        generation += 1;
        disconnect = () => context.close();
        await context.send({ jsonrpc: "2.0", id: message.id, result: {
          type: "initialized", protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
          capabilities: { "daemon.methods": {
            "session.processes.list": generation === 1,
            "session.processes.stop": generation === 1,
          } },
        } });
      } else if (message.method === "session.processes.stop") {
        stopGenerations.push(generation);
        await context.send({ jsonrpc: "2.0", id: message.id,
          error: { code: -32601, message: "Method unavailable" } });
      } else {
        await context.send({ jsonrpc: "2.0", id: message.id, result: { processes: [] } });
      }
    },
  });
  await server.listen();
  const client = await createConnectedAgenCJsonLineDaemonTuiClient({ socketPath, authCookie: "test-cookie" });
  const session = createDaemonTuiSessionFixture({
    baseSession: { conversationId: "session", services: {} }, sessionId: "session", clientId: "tui",
    client: { request: client.request, supportsMethod: client.supportsMethod,
      subscribeToSessionEvents: client.subscribeToSessionEvents },
  });
  try {
    expect(client.supportsMethod?.("session.processes.stop")).toBe(true);
    disconnect();
    await vi.waitFor(() => expect(client.getConnectionState().status).toBe("disconnected"));
    expect(client.supportsMethod?.("session.processes.stop")).toBe(true);
    await expect(session.stopDaemonSessionProcess?.("old-task-id")).rejects.toMatchObject({
      message: "This daemon does not support stopping session processes",
      cause: { code: -32601, message: "Method unavailable" },
    });
    expect(generation).toBe(2);
    expect(client.supportsMethod?.("session.processes.stop")).toBe(false);
    expect(await session.listDaemonSessionProcesses?.()).toBeUndefined();
    await expect(session.stopDaemonSessionProcess?.("old-task-id")).rejects.toThrow(
      "This daemon does not support stopping session processes",
    );
    expect(stopGenerations).toEqual([2]);
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
