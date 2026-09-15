import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ExecutionHostClient } from "../../src/execution/host-client.js";
import { executionEnvironmentCacheKey } from "../../src/execution/types.js";

let directory: string;
let server: Server | undefined;
const sockets = new Set<Socket>();

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "agenc-host-client-")); });
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  await rm(directory, { recursive: true, force: true });
});

async function serve(handle: (socket: Socket, value: Record<string, unknown>) => void): Promise<ExecutionHostClient> {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    socket.on("data", (bytes) => {
      input = Buffer.concat([input, bytes]);
      if (input.length < 4 || input.length < 4 + input.readUInt32BE(0)) return;
      handle(socket, JSON.parse(input.subarray(4).toString("utf8")) as Record<string, unknown>);
    });
  });
  const path = join(directory, "host.sock");
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(path, resolve);
  });
  return new ExecutionHostClient(path);
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(4 + body.length);
  result.writeUInt32BE(body.length);
  body.copy(result, 4);
  return result;
}

it("preserves exact Unicode arguments through framed host RPC", async () => {
  const payload = { method: "launch", args: ["literal\n α😃 ", "$(untouched)", ""] };
  const client = await serve((socket, message) => {
    expect(message).toEqual(payload);
    const response = frame({ ok: true, value: " α😃\n " });
    socket.write(response.subarray(0, 5));
    setImmediate(() => socket.end(response.subarray(5)));
  });
  expect(await client.request(payload)).toEqual({ ok: true, value: " α😃\n " });
});

it("does not reconnect or repeat a dispatched request after a lost acknowledgement", async () => {
  let calls = 0;
  const client = await serve((socket) => { calls++; socket.destroy(); });
  await expect(client.request({ method: "launch" })).rejects.toMatchObject({ code: "unknown_outcome", requestSent: true });
  expect(calls).toBe(1);
});

it("crosses admission immediately before send and preserves a rejected admission without sending", async () => {
  let dispatched = 0;
  const client = await serve((socket) => { dispatched++; socket.end(frame({ ok: true })); });
  const denied = new Error("canonical admission rejected");
  await expect(client.request({ method: "launch" }, { beforeSend: () => { throw denied; } })).rejects.toBe(denied);
  expect(dispatched).toBe(0);
  let boundaryCrossed = false;
  await client.request({ method: "launch" }, { beforeSend: () => { boundaryCrossed = true; } });
  expect(boundaryCrossed).toBe(true);
  expect(dispatched).toBe(1);
});

it("preserves native mutation failure evidence", async () => {
  const client = await serve((socket) => socket.end(frame({
    ok: false, code: "filesystem_failure", message: "partial write", mutationStarted: true,
  })));
  await expect(client.request({ method: "filesystem" })).rejects.toMatchObject({
    code: "filesystem_failure", requestSent: true, mutationStarted: true,
  });
});

it("rejects a declared oversized response without retaining its body", async () => {
  const client = await serve((socket) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(2 * 1024 * 1024 + 1);
    socket.end(header);
  });
  await expect(client.request({ method: "inspect" })).rejects.toMatchObject({ code: "host_protocol" });
});

it("does not dispatch an already-cancelled or oversized request", async () => {
  const client = new ExecutionHostClient(join(directory, "absent.sock"));
  const abort = new AbortController();
  abort.abort();
  await expect(client.request({ method: "launch" }, { signal: abort.signal })).rejects.toMatchObject({
    code: "aborted", requestSent: false,
  });
  await expect(client.request({ content: "x".repeat(2 * 1024 * 1024) })).rejects.toMatchObject({
    code: "invalid_request", requestSent: false,
  });
});

it("keys identical workspace paths by immutable environment generation", () => {
  const first = { kind: "docker" as const, containerId: "container-a", generation: "one", processHandleNamespace: "store-a" };
  const second = { kind: "docker" as const, containerId: "container-b", generation: "one", processHandleNamespace: "store-a" };
  expect(executionEnvironmentCacheKey(first, "/app")).not.toBe(executionEnvironmentCacheKey(second, "/app"));
  expect(executionEnvironmentCacheKey(first, "/app")).not.toBe(executionEnvironmentCacheKey({ ...first, generation: "two" }, "/app"));
  expect(executionEnvironmentCacheKey(first, "/app")).not.toBe(executionEnvironmentCacheKey({ ...first, processHandleNamespace: "store-b" }, "/app"));
  expect(executionEnvironmentCacheKey({ kind: "local" }, "/app")).not.toBe(executionEnvironmentCacheKey(first, "/app"));
});
