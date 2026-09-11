import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import { AgenCStdioTransport } from "../../src/app-server/transport/stdio.js";
import { AgenCUnixSocketServer, agenCDaemonLocalEndpoint } from "../../src/app-server/transport/unix-socket.js";
import { AgenCWebSocketServer } from "../../src/app-server/transport/websocket.js";

type Kind = "stdio" | "unix" | "websocket";

async function createHarness(
  kind: Kind,
  onMessage: (message: JsonObject) => Promise<void>,
  overrides: { acceptAuthenticator?: () => Promise<boolean> } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "agenc-control-liveness-"));
  const responses: JsonObject[] = [];
  const input = new PassThrough();
  const output = new PassThrough();
  const options = { onMessage, maxQueuedRequests: 2, ...overrides };
  const server = kind === "stdio"
    ? new AgenCStdioTransport({ ...options, input, output })
    : kind === "unix"
      ? new AgenCUnixSocketServer({ ...options, socketPath: agenCDaemonLocalEndpoint(directory) })
      : new AgenCWebSocketServer(options);
  let client: Socket | WebSocket | undefined;
  const collectLines = (source: PassThrough | Socket) => {
    let pending = "";
    source.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        responses.push(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
      }
    });
  };
  if (server instanceof AgenCStdioTransport) {
    collectLines(output);
    server.start();
  } else {
    await server.listen();
    client = server instanceof AgenCUnixSocketServer
      ? createConnection(server.socketPath)
      : new WebSocket(server.listenAddress!.url);
    if (client instanceof WebSocket) {
      client.on("message", (message) => responses.push(JSON.parse(message.toString())));
      await once(client, "open");
    } else {
      collectLines(client);
      await once(client, "connect");
    }
  }
  return {
    responses,
    server,
    send(method: string, id: number) {
      const payload = JSON.stringify({ jsonrpc: "2.0", method, id });
      if (client instanceof WebSocket) client.send(payload);
      else (client ?? input).write(`${payload}\n`);
    },
    async cleanup() {
      if (client instanceof WebSocket) client.terminate();
      else client?.destroy();
      await server.close();
      input.destroy();
      output.destroy();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe.each<Kind>(["stdio", "unix", "websocket"])("%s control request scheduling", (kind) => {
  it("does not let a duplicate initialize move cancellation behind an active stream", async () => {
    const stream = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const methods: string[] = [];
    const harness = await createHarness(kind, async (message) => {
      methods.push(String(message.method));
      if (message.method === "message.stream") {
        started.resolve();
        await stream.promise;
      } else if (message.method === "run.cancel") {
        stream.resolve();
      }
    });
    try {
      harness.send("initialize", 1);
      await expect.poll(() => methods).toEqual(["initialize"]);
      harness.send("message.stream", 2);
      await started.promise;
      harness.send("initialize", 3);
      harness.send("run.cancel", 4);
      await expect.poll(() => methods).toEqual([
        "initialize", "message.stream", "run.cancel", "initialize",
      ]);
    } finally {
      stream.resolve();
      await harness.cleanup();
    }
  });

  it("bounds priority backlog before initialization while reserving control capacity", async () => {
    const initialize = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const methods: string[] = [];
    const harness = await createHarness(kind, async (message) => {
      methods.push(String(message.method));
      if (message.method === "initialize") {
        started.resolve();
        await initialize.promise;
      }
    });
    try {
      harness.send("initialize", 1);
      await started.promise;
      for (let id = 10; id < 15; id += 1) harness.send("health.ping", id);
      for (let id = 20; id < 25; id += 1) harness.send("request.cancel", id);
      await expect.poll(() => harness.responses.length).toBe(6);
      expect(harness.responses.map((response) => response.id)).toEqual([12, 13, 14, 22, 23, 24]);
      for (const response of harness.responses) {
        expect(response).toMatchObject({ error: { data: { code: "TOO_MANY_QUEUED_REQUESTS", maxQueuedRequests: 2 } } });
      }
      expect(methods).toEqual(["initialize"]);
      initialize.resolve();
      await expect.poll(() => methods.length).toBe(5);
      expect(methods.filter((method) => method === "request.cancel")).toHaveLength(2);
      // Settled requests release their lane's capacity.
      harness.send("health.ping", 30);
      await expect.poll(() => methods.length).toBe(6);
      expect(harness.responses).toHaveLength(6);
    } finally {
      initialize.resolve();
      await harness.cleanup();
    }
  });
});

describe.each(["unix", "websocket"] as const)("%s bounded shutdown drain", (kind) => {
  it.each(["handler", "authentication"])("closes its listener before reporting a stalled %s drain deadline", async (phase) => {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const pending = async () => {
      started.resolve();
      await release.promise;
      return true;
    };
    const harness = await createHarness(
      kind, async () => { await pending(); },
      phase === "authentication" ? { acceptAuthenticator: pending } : {},
    );
    try {
      harness.send("initialize", 1);
      await started.promise;
      if (harness.server instanceof AgenCStdioTransport) throw new Error("network transport required");
      const address = harness.server instanceof AgenCWebSocketServer ? harness.server.listenAddress : null;
      await expect(harness.server.close({ drainTimeoutMs: 20 })).rejects.toThrow("request drain exceeded 20 ms");
      // close() has already released the listening endpoint, not just dropped
      // its connection registry while leaving the network server alive.
      if (harness.server instanceof AgenCUnixSocketServer) {
        const client = createConnection(harness.server.socketPath);
        await expect(once(client, "connect")).rejects.toMatchObject({ code: "ENOENT" });
        client.destroy();
      } else {
        expect(harness.server.listenAddress).toBeNull();
        const client = createConnection({ host: address!.host, port: address!.port });
        await expect(once(client, "connect")).rejects.toMatchObject({ code: "ECONNREFUSED" });
        client.destroy();
      }
    } finally {
      release.resolve();
      await harness.cleanup();
    }
  });
});

it("closes HTTP peers waiting for an incomplete request body", async () => {
  const server = new AgenCWebSocketServer({ onMessage: async () => {} });
  const address = await server.listen();
  const peer = createConnection({ host: address.host, port: address.port });
  let closing: Promise<void> | undefined;
  try {
    await once(peer, "connect");
    const response = once(peer, "data");
    peer.write("POST /healthz HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx");
    await response;
    let closed = false;
    closing = server.close().then(() => { closed = true; });
    await expect.poll(() => closed, { timeout: 1_000 }).toBe(true);
  } finally {
    peer.destroy();
    await closing;
    await server.close();
  }
});
