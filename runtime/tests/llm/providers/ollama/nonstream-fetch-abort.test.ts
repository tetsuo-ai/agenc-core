import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, expect, test } from "vitest";

import { OllamaProvider } from "../../../../src/llm/providers/ollama/adapter.js";

/**
 * No injected client. The installed SDK posts /api/chat through
 * ensureClient's fetch wrapper, which must close the socket on timeout
 * and on caller cancel.
 */
async function stallingChatServer() {
  const sockets = new Set<Socket>();
  const paths: string[] = [];
  let chatSocketsClosed = 0;
  let resolveChat!: () => void;
  let resolveClosed!: () => void;
  const chatStarted = new Promise<void>((resolve) => {
    resolveChat = resolve;
  });
  const chatClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    paths.push(url);
    request.on("data", () => {});
    request.on("end", () => {
      if (url.startsWith("/api/chat")) {
        request.socket.once("close", () => {
          chatSocketsClosed += 1;
          resolveClosed();
        });
        resolveChat();
        return;
      }
      const body = url.startsWith("/api/tags") ? "{\"models\":[]}" : "{}";
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    chatStarted,
    chatClosed,
    get chatSocketsClosed() {
      return chatSocketsClosed;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("Ollama non-stream fetch abort through the real SDK", () => {
  test("a timeout closes the stalled /api/chat socket", async () => {
    const fixture = await stallingChatServer();
    try {
      const provider = new OllamaProvider({
        model: "abort-test",
        host: fixture.url,
        timeoutMs: 200,
      });
      await expect(provider.chat(
        [{ role: "user", content: "hello" }],
        { singleWireAttempt: true, timeoutMs: 200 },
      )).rejects.toThrow();
      await fixture.chatClosed;
      expect(fixture.chatSocketsClosed).toBe(1);
      expect(fixture.paths.some((path) => path.startsWith("/api/chat"))).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 10_000);

  test("caller cancel closes the stalled /api/chat socket", async () => {
    const fixture = await stallingChatServer();
    const controller = new AbortController();
    try {
      const provider = new OllamaProvider({
        model: "abort-test",
        host: fixture.url,
        timeoutMs: 30_000,
      });
      const pending = provider.chat(
        [{ role: "user", content: "hello" }],
        { singleWireAttempt: true, timeoutMs: 30_000, signal: controller.signal },
      );
      const failure = pending.then(
        () => {
          throw new Error("chat resolved");
        },
        (error: unknown) => error,
      );
      await fixture.chatStarted;
      controller.abort(new Error("caller cancelled"));
      await failure;
      await fixture.chatClosed;
      expect(fixture.chatSocketsClosed).toBe(1);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 10_000);
});
