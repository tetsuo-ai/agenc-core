import { createServer, type AddressInfo, type Socket } from "node:net";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, test } from "vitest";

import { concurrentChatFetch, DEEPSEEK_IDLE_CONNECTION_MS } from "../../../../src/llm/providers/concurrent-chat-fetch.js";

/**
 * A loopback HTTP/1.1 server that answers like api.deepseek.com: it keeps an
 * idle connection open and its responses say `Connection: keep-alive` without
 * naming a keep-alive time, so the client's own idle limit decides.
 */
async function withServer(run: (url: string, connections: () => number) => Promise<void>): Promise<void> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = pending.subarray(0, end).toString("latin1");
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        if (pending.length < end + 4 + length) return;
        pending = pending.subarray(end + 4 + length);
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, () => connections);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a DeepSeek request after a pause longer than undici's 4 s idle default reuses the open connection", async () => {
  const previous = getGlobalDispatcher();
  const global = new Agent();
  setGlobalDispatcher(global);
  try {
    await withServer(async (url, connections) => {
      const chatFetch = concurrentChatFetch();
      await (await chatFetch(url, { method: "POST", body: "{}" })).text();
      // A person's pause before the next message. Undici's own default closes the connection after 4 s.
      await new Promise((resolve) => setTimeout(resolve, 4_500));
      await (await concurrentChatFetch()(url, { method: "POST", body: "{}" })).text();
      expect(connections()).toBe(1);
    });
  } finally {
    setGlobalDispatcher(previous);
    await global.destroy();
  }
  expect(DEEPSEEK_IDLE_CONNECTION_MS).toBeGreaterThan(4_500);
}, 15_000);

test("a configured global dispatcher keeps its own policy for DeepSeek requests", async () => {
  const previous = getGlobalDispatcher();
  const global = new Agent({ connect: { timeout: 5_000 } });
  let throughGlobal = 0;
  global.on("connect", () => { throughGlobal += 1; });
  setGlobalDispatcher(global);
  try {
    await withServer(async (url, connections) => {
      await (await concurrentChatFetch()(url, { method: "POST", body: "{}" })).text();
      expect(connections()).toBe(1);
      expect(throughGlobal).toBe(1);
    });
  } finally {
    setGlobalDispatcher(previous);
    await global.destroy();
  }
});
