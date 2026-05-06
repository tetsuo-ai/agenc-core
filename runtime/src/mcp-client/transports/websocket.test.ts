import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  MCPWebSocketClientTransport,
  WEBSOCKET_CLOSE_WAIT_MS,
} from "./websocket.js";

const servers = new Set<WebSocketServer>();

afterEach(async () => {
  await Promise.all(
    Array.from(servers).map(async (server) => {
      servers.delete(server);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }),
  );
});

describe("MCPWebSocketClientTransport", () => {
  it("sends headers, writes JSON-RPC messages, and decodes responses", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.add(server);
    const receivedHeaders = new Promise<Record<string, string | string[] | undefined>>(
      (resolve) => {
        server.once("connection", (socket, request) => {
          resolve(request.headers);
          socket.on("message", (data) => {
            socket.send(data.toString());
          });
        });
      },
    );
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected TCP WebSocket server address");
    }

    const transport = new MCPWebSocketClientTransport(
      new URL(`ws://127.0.0.1:${address.port}/mcp`),
      { Authorization: "Bearer local-test" },
    );
    const response = new Promise((resolve) => {
      transport.onmessage = resolve;
    });

    await transport.start();
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { value: true },
    });

    await expect(receivedHeaders).resolves.toMatchObject({
      authorization: "Bearer local-test",
    });
    await expect(response).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { value: true },
    });
    await transport.close();
  });

  it("rejects send before the socket opens", async () => {
    const transport = new MCPWebSocketClientTransport(
      new URL("ws://127.0.0.1:9/mcp"),
    );

    await expect(
      transport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      }),
    ).rejects.toThrow(/not open/i);
  });

  it("terminates the socket when the close handshake times out", async () => {
    vi.useFakeTimers();
    try {
      const transport = new MCPWebSocketClientTransport(
        new URL("ws://127.0.0.1:9/mcp"),
      );
      let closeHandler: (() => void) | undefined;
      const fakeSocket = {
        readyState: WebSocket.OPEN,
        close: vi.fn(() => {
          fakeSocket.readyState = WebSocket.CLOSING;
        }),
        terminate: vi.fn(() => {
          fakeSocket.readyState = WebSocket.CLOSED;
          closeHandler?.();
        }),
        once: vi.fn((event: string, handler: () => void) => {
          if (event === "close") closeHandler = handler;
          return fakeSocket;
        }),
        off: vi.fn(() => fakeSocket),
      };
      (transport as unknown as { socket: typeof fakeSocket }).socket = fakeSocket;

      const closed = transport.close();
      await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_WAIT_MS);
      await closed;

      expect(fakeSocket.close).toHaveBeenCalledOnce();
      expect(fakeSocket.terminate).toHaveBeenCalledOnce();
      expect(fakeSocket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces malformed server messages through onerror", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.add(server);
    server.once("connection", (socket) => {
      socket.send("not-json");
    });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected TCP WebSocket server address");
    }

    const transport = new MCPWebSocketClientTransport(
      new URL(`ws://127.0.0.1:${address.port}/mcp`),
    );
    const error = new Promise<Error>((resolve) => {
      transport.onerror = resolve;
    });

    await transport.start();
    await expect(error).resolves.toBeInstanceOf(Error);
    await transport.close();
  });
});
