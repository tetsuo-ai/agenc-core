import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAgenCJsonLineDaemonRequestClient, createConnectedAgenCJsonLineDaemonTuiClient } from "../../src/app-server/agent-cli.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function peer(hang: string) {
  const home = await mkdtemp(join(tmpdir(), "dc-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const socketPath = join(home, "s"), sockets = new Set<Socket>(), methods: string[] = [];
  let connectionCount = 0;
  const server = createServer(socket => {
    connectionCount++; sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {}); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", data => {
      buffer += data;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n"), msg = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        methods.push(msg.method);
        if (msg.method === hang || msg.id === undefined) continue;
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize" ? { capabilities: {} } : {} }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); });
  return { options: { socketPath, authCookie: "fixture", userHome: home, env: { HOME: home, AGENC_HOME: home }, timeoutMs: 400 },
    sockets, methods, count: () => connectionCount, closeServer: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function until(check: () => boolean) {
  const end = Date.now() + 1_000;
  while (!check()) { if (Date.now() >= end) throw new Error("fixture condition timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
for (const phase of ["initialize", "agent.stop"]) {
  it(`aborts real socket I/O during ${phase} and closes the peer connection`, async () => {
    const p = await peer(phase), controller = new AbortController();
    const client = createAgenCJsonLineDaemonRequestClient(p.options);
    const result = client.request("agent.stop", { agentId: "owned", reason: "done" }, { signal: controller.signal }).catch(error => error);
    await until(() => p.methods.includes(phase)); controller.abort();
    expect(String(await result)).toMatch(/cancelled/i);
    await until(() => p.sockets.size === 0);
    if (phase === "initialize") expect(p.methods).not.toContain("agent.stop");
    expect(p.count()).toBe(1);
  });
}
it("does not connect for an already cancelled request", async () => {
  const p = await peer(""), controller = new AbortController(); controller.abort();
  const client = createAgenCJsonLineDaemonRequestClient(p.options);
  await expect(client.request("agent.stop", {}, { signal: controller.signal })).rejects.toThrow(/cancelled/i);
  expect(p.count()).toBe(0);
});
it("cancels the absent socket retry delay", async () => {
  const p = await peer(""); await p.closeServer();
  const controller = new AbortController(), client = createAgenCJsonLineDaemonRequestClient(p.options);
  const result = client.request("agent.stop", {}, { signal: controller.signal }).catch(error => error);
  setTimeout(() => controller.abort(), 40);
  expect(String(await result)).toMatch(/cancelled/i);
});
it("rejects a connected-only operation without entering reconnect, while ordinary requests still recover", async () => {
  const p = await peer(""), client = await createConnectedAgenCJsonLineDaemonTuiClient(p.options);
  cleanups.push(() => client.close());
  for (const socket of p.sockets) socket.destroy();
  await until(() => client.getConnectionState().status === "disconnected");
  await expect(client.request("agent.stop", {}, { reconnect: false } as never)).rejects.toThrow(/closed|disconnected/i);
  expect(p.count()).toBe(1);
  await client.request("agent.list", {});
  expect(p.count()).toBe(2);
});
it("cancelling one persistent request leaves another request usable", async () => {
  const p = await peer("agent.stop"), client = await createConnectedAgenCJsonLineDaemonTuiClient(p.options);
  cleanups.push(() => client.close());
  const controller = new AbortController();
  const stopped = client.request("agent.stop", {}, { signal: controller.signal }).catch(error => error);
  await until(() => p.methods.includes("agent.stop")); controller.abort();
  expect(String(await stopped)).toMatch(/cancelled/i);
  await client.request("agent.list", {});
  expect(client.getConnectionState().status).toBe("connected");
  expect(p.count()).toBe(1);
});
