import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCInProcessDaemonTransport } from "../../src/app-server/transport/in-process.js";
import { AgenCUnixSocketServer } from "../../src/app-server/transport/unix-socket.js";
import { AgenCWebSocketServer } from "../../src/app-server/transport/websocket.js";

describe.each(["unix", "websocket"] as const)("%s transport lifecycle ownership", (kind) => {
  async function fixture(onMessage: () => void | Promise<void> = () => {}) {
    const directory = await mkdtemp(join(tmpdir(), "agenc-transport-generation-"));
    const server = kind === "unix"
      ? new AgenCUnixSocketServer({ socketPath: join(directory, "daemon.sock"), onMessage })
      : new AgenCWebSocketServer({ port: 0, onMessage });
    const connect = async () => {
      const client = server instanceof AgenCUnixSocketServer
        ? createConnection(server.socketPath)
        : new WebSocket(server.listenAddress!.url);
      await once(client, client instanceof WebSocket ? "open" : "connect");
      return client;
    };
    return {
      server, connect,
      async cleanup() {
        await server.close().catch(() => {});
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  it("close owns an already requested startup until its listener is released", async () => {
    const { server, cleanup } = await fixture();
    const starting = server.listen();
    const closing = server.close();
    try {
      await closing;
      await starting;
      if (server instanceof AgenCUnixSocketServer) {
        const client = createConnection(server.socketPath);
        const event = await Promise.race([
          once(client, "error").then(() => "closed"),
          once(client, "connect").then(() => "listening", () => "closed"),
        ]);
        client.destroy();
        expect(event).toBe("closed");
      } else {
        expect(server.listenAddress).toBeNull();
      }
      // Completion returns the object to a usable, fully closed generation.
      await expect(server.listen()).resolves.toBeDefined();
    } finally {
      await Promise.allSettled([starting, closing]);
      await cleanup();
    }
  });

  it("rejects competing startups before either can replace listener ownership", async () => {
    const { server, cleanup } = await fixture();
    const starting = server.listen();
    const duplicate = server.listen();
    try {
      await expect(duplicate).rejects.toThrow("already");
      await starting;
    } finally {
      await Promise.allSettled([starting, duplicate]);
      await cleanup();
    }
  });

  it("coalesces close and rejects restart until the old request drain settles", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { server, connect, cleanup } = await fixture(async () => {
      entered.resolve();
      await release.promise;
    });
    let client: Socket | WebSocket | undefined;
    try {
      await server.listen();
      client = await connect();
      const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health.ping" });
      if (client instanceof WebSocket) client.send(request);
      else client.write(`${request}\n`);
      await entered.promise;
      const first = server.close();
      const second = server.close();
      const completed: string[] = [];
      void first.then(() => completed.push("first"));
      void second.then(() => completed.push("second"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toEqual([]);
      await expect(server.listen()).rejects.toThrow("closing");
      release.resolve();
      await Promise.all([first, second]);
      await server.listen();
      const replacement = await connect();
      if (replacement instanceof WebSocket) replacement.terminate();
      else replacement.destroy();
    } finally {
      release.resolve();
      if (client instanceof WebSocket) client.terminate();
      else client?.destroy();
      await cleanup();
    }
  });
});

describe("in-process transport close ownership", () => {
  it.each([false, true])("every close joins pending connection cleanup (failure=%s)", async (fail) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error("connection cleanup failed");
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      commandExec: {
        start: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        write: async () => ({}), resize: async () => ({}), terminate: async () => ({}),
        closeConnection: async () => {
          entered.resolve();
          await release.promise;
          if (fail) throw failure;
        },
      },
    });
    const transport = new AgenCInProcessDaemonTransport({ dispatcher });
    const first = transport.close();
    await entered.promise;
    const second = transport.close();
    const completed: string[] = [];
    void first.then(() => completed.push("first"), () => completed.push("first"));
    void second.then(() => completed.push("second"), () => completed.push("second"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(completed).toEqual([]);
    } finally {
      release.resolve();
    }
    const outcomes = await Promise.allSettled([first, second, transport.close()]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(
      Array(3).fill(fail ? "rejected" : "fulfilled"),
    );
    await dispatcher.close();
  });
});
