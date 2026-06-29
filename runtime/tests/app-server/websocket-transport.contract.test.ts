import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  AgenCWebSocketServer as PublicAgenCWebSocketServer,
  encodeJsonPayload as publicEncodeJsonPayload,
  parseJsonObjectPayload as publicParseJsonObjectPayload,
} from "../index.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import {
  AgenCWebSocketServer,
  type AgenCWebSocketMessageContext,
  encodeJsonPayload,
  parseJsonObjectPayload,
} from "./transport/websocket.js";

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(data.toString());
    });
  });
}

function nextClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
  });
}

function waitForErrorCount(
  errors: readonly Error[],
  count: number,
): Promise<readonly Error[]> {
  if (errors.length >= count) return Promise.resolve(errors);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (errors.length >= count) {
        clearInterval(timer);
        resolve(errors);
        return;
      }
      if (Date.now() - startedAt > 1000) {
        clearInterval(timer);
        resolve([
          ...errors,
          new Error("timed out waiting for websocket transport error"),
        ]);
      }
    }, 10);
  });
}

async function rejectedUpgradeStatus(
  url: string,
  options: WebSocket.ClientOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("websocket upgrade unexpectedly succeeded"));
    });
    socket.once("error", reject);
  });
}

describe("AgenC websocket app-server transport", () => {
  it("accepts JSON-RPC objects over a websocket and sends responses", async () => {
    const server = new AgenCWebSocketServer({
      onMessage: async (message, connection) => {
        expect(connection.connectionId).toBe(1);
        expect(connection.requestUrl).toBe("/");
        expect(message).toEqual({
          jsonrpc: JSON_RPC_VERSION,
          id: 1,
          method: "agent.list",
          params: {},
        });
        await connection.send({
          jsonrpc: JSON_RPC_VERSION,
          id: 1,
          result: { agents: [] },
        });
      },
    });

    const address = await server.listen();
    const client = new WebSocket(address.url);
    await once(client, "open");
    client.send(
      '{"jsonrpc":"2.0","id":1,"method":"agent.list","params":{}}',
    );

    await expect(nextMessage(client)).resolves.toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"agents":[]}}',
    );

    client.close();
    await nextClose(client);
    await server.close();
  });

  it("dispatches two pipelined same-connection requests in arrival order", async () => {
    // Regression for audit #13: websocket dispatch used to be fire-and-forget,
    // so a slow first handler let a later pipelined request complete first and
    // corrupt order-dependent flows on the same connection.
    const completionOrder: number[] = [];
    let resolveFirst: (() => void) | undefined;
    const server = new AgenCWebSocketServer({
      onMessage: async (message, connection) => {
        const id = message.id as number;
        if (id === 1) {
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        completionOrder.push(id);
        await connection.send({ jsonrpc: JSON_RPC_VERSION, id, result: {} });
      },
    });

    const address = await server.listen();
    const client = new WebSocket(address.url);
    await once(client, "open");
    client.send('{"jsonrpc":"2.0","id":1,"method":"session.clear"}');
    client.send('{"jsonrpc":"2.0","id":2,"method":"message.send"}');

    await delay(20);
    expect(completionOrder).toEqual([]);

    resolveFirst?.();
    await delay(40);
    expect(completionOrder).toEqual([1, 2]);

    client.close();
    await nextClose(client);
    await server.close();
  });

  it("dispatches request.cancel ahead of an in-flight long request", async () => {
    // Regression for the transport-FIFO cancellation starvation: a
    // request.cancel chained behind a long-running request could never run
    // until that request completed, defeating cancellation. Control messages
    // must dispatch off-chain so cancel runs while the target is still in
    // flight, while normal requests stay FIFO (guarded by the test above).
    const events: string[] = [];
    let releaseLong: (() => void) | undefined;
    let resolveStarted: () => void = () => {};
    const longStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const server = new AgenCWebSocketServer({
      onMessage: async (message) => {
        if (message.method === "session.partialCompactFromMessage") {
          events.push("long:start");
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseLong = resolve;
          });
          events.push("long:end");
        } else if (message.method === "request.cancel") {
          events.push("cancel");
        }
      },
    });

    const address = await server.listen();
    const client = new WebSocket(address.url);
    await once(client, "open");
    client.send(
      '{"jsonrpc":"2.0","id":1,"method":"session.partialCompactFromMessage"}',
    );
    await longStarted;
    client.send('{"jsonrpc":"2.0","id":2,"method":"request.cancel"}');

    await delay(40);
    // Cancel must have run while the long request is still blocked.
    expect(events).toEqual(["long:start", "cancel"]);

    releaseLong?.();
    await delay(40);
    expect(events).toEqual(["long:start", "cancel", "long:end"]);

    client.close();
    await nextClose(client);
    await server.close();
  });

  it("rejects normal requests beyond the per-connection queue cap", async () => {
    let releaseFirst: (() => void) | undefined;
    let resolveStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const server = new AgenCWebSocketServer({
      maxQueuedRequests: 1,
      onMessage: async (message) => {
        if (message.id === 1) {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
    });

    const address = await server.listen();
    const client = new WebSocket(address.url);
    await once(client, "open");
    client.send('{"jsonrpc":"2.0","id":1,"method":"session.clear"}');
    await firstStarted;
    client.send('{"jsonrpc":"2.0","id":2,"method":"message.send"}');

    const rejected = JSON.parse(await nextMessage(client));
    expect(rejected).toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      error: {
        code: -32000,
        data: {
          code: "TOO_MANY_QUEUED_REQUESTS",
          maxQueuedRequests: 1,
        },
      },
    });

    releaseFirst?.();
    client.close();
    await nextClose(client);
    await server.close();
  });

  it("serves health probes and rejects unsafe HTTP and upgrade requests", async () => {
    const server = new AgenCWebSocketServer({
      ready: () => false,
      onMessage: () => {},
    });

    const address = await server.listen();
    await expect(fetch(address.healthUrl).then((response) => response.status))
      .resolves.toBe(200);
    await expect(fetch(address.readyUrl).then((response) => response.status))
      .resolves.toBe(503);
    await expect(
      fetch(address.healthUrl, { method: "POST" }).then(
        (response) => response.status,
      ),
    ).resolves.toBe(405);
    await expect(
      rejectedUpgradeStatus(address.url, {
        headers: { Origin: "https://agenc.tech" },
      }),
    ).resolves.toBe(403);
    await expect(
      rejectedUpgradeStatus(`ws://${address.host}:${address.port}/wrong`),
    ).resolves.toBe(404);

    await server.close();
  });

  it("allows callers to admit a trusted browser origin", async () => {
    const server = new AgenCWebSocketServer({
      validateOrigin: (origin) => origin === "https://agenc.tech",
      onMessage: async (_message, connection) => {
        await connection.send({ ok: true });
      },
    });

    const address = await server.listen();
    const client = new WebSocket(address.url, {
      headers: { Origin: "https://agenc.tech" },
    });
    await once(client, "open");
    client.send("{}");
    await expect(nextMessage(client)).resolves.toBe('{"ok":true}');

    client.close();
    await nextClose(client);
    await server.close();
  });

  it("reports malformed payloads without closing the connection", async () => {
    const errors: Error[] = [];
    const server = new AgenCWebSocketServer({
      onError: (error) => {
        errors.push(error);
      },
      onMessage: async (_message, connection) => {
        await connection.send({ ok: true });
      },
    });

    const address = await server.listen();
    const client = new WebSocket(address.url);
    await once(client, "open");
    client.send("not-json");
    await expect(waitForErrorCount(errors, 1)).resolves.toMatchObject([
      { name: "SyntaxError" },
    ]);
    client.send("[]");
    await expect(waitForErrorCount(errors, 2)).resolves.toMatchObject([
      { name: "SyntaxError" },
      { name: "TypeError" },
    ]);
    client.send("");
    await expect(waitForErrorCount(errors, 3)).resolves.toMatchObject([
      { name: "SyntaxError" },
      { name: "TypeError" },
      { name: "SyntaxError" },
    ]);

    client.send("{}");
    await expect(nextMessage(client)).resolves.toBe('{"ok":true}');

    client.close();
    await nextClose(client);
    await server.close();
  });

  it("ignores binary frames while keeping the connection usable", async () => {
    let messages = 0;
    const server = new AgenCWebSocketServer({
      onMessage: async (_message, connection) => {
        messages += 1;
        await connection.send({ messages });
      },
    });

    const address = await server.listen();
    const client = new WebSocket(address.url);
    await once(client, "open");
    client.send(Buffer.from([1, 2, 3]), { binary: true });
    await delay(20);
    expect(messages).toBe(0);

    client.send("{}");
    await expect(nextMessage(client)).resolves.toBe('{"messages":1}');

    client.close();
    await nextClose(client);
    await server.close();
  });

  it("isolates simultaneous clients by connection id and response socket", async () => {
    const seenConnectionIds: number[] = [];
    const server = new AgenCWebSocketServer({
      onMessage: async (message, connection) => {
        seenConnectionIds.push(connection.connectionId);
        await connection.send({
          connectionId: connection.connectionId,
          requestId: message.id,
        });
      },
    });

    const address = await server.listen();
    const clientA = new WebSocket(address.url);
    const clientB = new WebSocket(address.url);
    await Promise.all([once(clientA, "open"), once(clientB, "open")]);
    const messageA = nextMessage(clientA);
    const messageB = nextMessage(clientB);
    clientA.send('{"id":"a"}');
    clientB.send('{"id":"b"}');

    const responseA = JSON.parse(await messageA) as {
      connectionId: number;
      requestId: string;
    };
    const responseB = JSON.parse(await messageB) as {
      connectionId: number;
      requestId: string;
    };
    expect(responseA).toMatchObject({ requestId: "a" });
    expect(responseB).toMatchObject({ requestId: "b" });
    expect(responseA.connectionId).not.toBe(responseB.connectionId);
    expect([responseA.connectionId, responseB.connectionId].sort()).toEqual([
      1, 2,
    ]);
    expect([...seenConnectionIds].sort()).toEqual([1, 2]);

    clientA.close();
    clientB.close();
    await Promise.all([nextClose(clientA), nextClose(clientB)]);
    await server.close();
  });

  it("closes active connections and reports connection cleanup", async () => {
    const closedConnectionIds: number[] = [];
    const server = new AgenCWebSocketServer({
      onMessage: () => {},
      onConnectionClosed: (connectionId) => {
        closedConnectionIds.push(connectionId);
      },
    });

    const address = await server.listen();
    const client = new WebSocket(address.url);
    await once(client, "open");

    await server.close();
    await server.close();
    await nextClose(client);
    expect(closedConnectionIds).toEqual([1]);
  });

  it("allows close before listen and observes client disconnects", async () => {
    const neverStarted = new AgenCWebSocketServer({
      onMessage: () => {},
    });
    await neverStarted.close();
    await neverStarted.close();

    const closedConnectionIds: number[] = [];
    const server = new AgenCWebSocketServer({
      onMessage: () => {},
      onConnectionClosed: (connectionId) => {
        closedConnectionIds.push(connectionId);
      },
    });
    const address = await server.listen();
    const client = new WebSocket(address.url);
    await once(client, "open");
    client.close();
    await nextClose(client);

    expect(closedConnectionIds).toEqual([1]);
    await server.close();
  });

  it("waits for pending message handlers during close", async () => {
    let releaseHandler: () => void = () => {};
    let closeResolved = false;
    let resolveStarted: () => void = () => {};
    const handlerStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const server = new AgenCWebSocketServer({
      onMessage: async () => {
        resolveStarted();
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
      },
    });

    const address = await server.listen();
    const client = new WebSocket(address.url);
    await once(client, "open");
    client.send("{}");
    await handlerStarted;
    const closePromise = server.close().then(() => {
      closeResolved = true;
    });
    await delay(20);
    expect(closeResolved).toBe(false);
    releaseHandler();
    await closePromise;
    await nextClose(client);
    expect(closeResolved).toBe(true);
  });

  it("rejects sends after a connection is closed", async () => {
    let acceptedConnection: AgenCWebSocketMessageContext | undefined;
    let resolveAccepted: () => void = () => {};
    const accepted = new Promise<void>((resolve) => {
      resolveAccepted = resolve;
    });
    const server = new AgenCWebSocketServer({
      onMessage: (_message, connection) => {
        acceptedConnection = connection;
        resolveAccepted();
      },
    });

    const address = await server.listen();
    const client = new WebSocket(address.url);
    await once(client, "open");
    client.send("{}");
    await accepted;
    client.close();
    await nextClose(client);

    if (acceptedConnection === undefined) {
      throw new Error("websocket test did not capture a connection");
    }
    await expect(acceptedConnection.send({ ok: true })).rejects.toThrow(
      "connection is not open",
    );
    await server.close();
  });

  it("is reachable through the public runtime barrel", () => {
    expect(PublicAgenCWebSocketServer).toBe(AgenCWebSocketServer);
    expect(publicEncodeJsonPayload).toBe(encodeJsonPayload);
    expect(publicParseJsonObjectPayload).toBe(parseJsonObjectPayload);
    expect(parseJsonObjectPayload('{"ok":true}')).toEqual({ ok: true });
    expect(encodeJsonPayload({ ok: true })).toBe('{"ok":true}');
  });
});
