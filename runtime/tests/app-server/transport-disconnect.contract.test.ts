import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import {
  AgenCUnixSocketServer,
  agenCDaemonLocalEndpoint,
} from "../../src/app-server/transport/unix-socket.js";
import { AgenCWebSocketServer } from "../../src/app-server/transport/websocket.js";

type TransportKind = "unix" | "websocket";

async function createHarness(
  kind: TransportKind,
  options: {
    onMessage(message: JsonObject): void | Promise<void>;
    acceptAuthenticator?: () => Promise<boolean>;
    acceptAuthenticationTimeoutMs?: number;
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "agenc-transport-close-"));
  const closedConnections = new Set<number>();
  const common = {
    ...options,
    onConnectionClosed: (id: number) => { closedConnections.add(id); },
  };
  const server = kind === "unix"
    ? new AgenCUnixSocketServer({
        ...common,
        socketPath: agenCDaemonLocalEndpoint(directory),
      })
    : new AgenCWebSocketServer(common);
  try {
    await server.listen();
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const clients: { close(): void }[] = [];
  return {
    closedConnections,
    async connect() {
      const client = server instanceof AgenCUnixSocketServer
        ? createConnection(server.socketPath)
        : new WebSocket(server.listenAddress!.url);
      const close = () => {
        if (client instanceof WebSocket) client.terminate();
        else client.destroy();
      };
      clients.push({ close });
      await once(client, client instanceof WebSocket ? "open" : "connect");
      return {
        send(method: string, id: number) {
          const payload = JSON.stringify({ jsonrpc: "2.0", id, method });
          if (client instanceof WebSocket) client.send(payload);
          else client.write(`${payload}\n`);
        },
        close,
      };
    },
    closeServer: () => server.close(),
    async cleanup() {
      for (const client of clients) client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe.each<TransportKind>(["unix", "websocket"])(
  "%s daemon connection lifetime",
  (kind) => {
    it("discards queued normal and priority requests after disconnect", async () => {
      const release = Promise.withResolvers<void>();
      const initialized = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      const received: string[] = [];
      const harness = await createHarness(kind, {
        async onMessage(message) {
          received.push(String(message.method));
          if (message.method === "initialize") {
            initialized.resolve();
            await release.promise;
            completed.resolve();
          }
        },
      });
      try {
        const client = await harness.connect();
        client.send("initialize", 1);
        client.send("session.clear", 2);
        client.send("agent.create", 3);
        client.send("run.cancel", 4);
        await initialized.promise;
        client.close();
        await expect.poll(() => harness.closedConnections.size).toBe(1);
        release.resolve();
        await completed.promise;
        await nextTurn();
        expect(received).toEqual(["initialize"]);
      } finally {
        release.resolve();
        await harness.cleanup();
      }
    });

    it.each(["disconnect", "authentication timeout"])(
      "does not dispatch a late authentication success after %s",
      async (reason) => {
        const release = Promise.withResolvers<boolean>();
        const started = Promise.withResolvers<void>();
        const received: JsonObject[] = [];
        const harness = await createHarness(kind, {
          acceptAuthenticationTimeoutMs: reason === "disconnect" ? 60_000 : 30,
          acceptAuthenticator: () => {
            started.resolve();
            return release.promise;
          },
          onMessage(message) { received.push(message); },
        });
        try {
          const client = await harness.connect();
          client.send("initialize", 1);
          client.send("agent.create", 2);
          await started.promise;
          if (reason === "disconnect") client.close();
          await expect.poll(() => harness.closedConnections.size).toBe(1);
          release.resolve(true);
          await nextTurn();
          expect(received).toEqual([]);
        } finally {
          release.resolve(true);
          await harness.cleanup();
        }
      },
    );

    it("closes every peer before draining active handlers and discards queued work", async () => {
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const received: string[] = [];
      const harness = await createHarness(kind, {
        async onMessage(message) {
          received.push(String(message.method));
          if (message.method === "message.stream") {
            started.resolve();
            await release.promise;
          }
        },
      });
      let closing: Promise<void> | undefined;
      try {
        const first = await harness.connect();
        await harness.connect();
        first.send("message.stream", 1);
        first.send("message.send", 2);
        await started.promise;
        let drained = false;
        closing = harness.closeServer().then(() => { drained = true; });
        await expect.poll(() => harness.closedConnections.size).toBe(2);
        expect(drained).toBe(false);
        release.resolve();
        await closing;
        expect(received).toEqual(["message.stream"]);
      } finally {
        release.resolve();
        await closing;
        await harness.cleanup();
      }
    });
  },
);
