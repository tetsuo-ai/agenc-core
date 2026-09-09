import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, realpath, chmod, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createHttpMCPConnection } from "./http.js";
import { verifyDesktopAuthority } from "../desktop-authority.js";
import * as authority from "../desktop-authority.js";
import { withDesktopMcpDispatchGuard, DesktopMcpPreflightRefusal, withLocalMcpAccess, hasLocalMcpAccess } from "../local-control.js";

const roots: string[] = [];
const servers: Server[] = [];
const clients: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(validProof = true) {
  const temp = await realpath("/tmp");
  const home = await mkdtemp(join(temp, "agenc-authority-http-")); roots.push(home); await chmod(home, 0o700);
  const socketRoot = await mkdtemp(join(temp, "agenc-dc-")); roots.push(socketRoot); await chmod(socketRoot, 0o700);
  const socketPath = join(socketRoot, "control.sock");
  let tcpCalls = 0;
  const decoy = createServer((_request, response) => { tcpCalls++; response.writeHead(500); response.end("TCP must never be used"); }); servers.push(decoy);
  await new Promise<void>(resolve => decoy.listen(0, "127.0.0.1", resolve));
  const address = decoy.address(); if (!address || typeof address === "string") throw new Error("missing address");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const authorization = `Bearer ${"s".repeat(48)}`;
  const keys = generateKeyPairSync("ed25519");
  const requests: { path: string | undefined; authorization: string | undefined; rpcMethod?: string }[] = [];
  const server = createServer(async (request, response) => {
    const observed: typeof requests[number] = { path: request.url, authorization: request.headers.authorization };
    requests.push(observed);
    let raw = ""; for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    if (typeof body.method === "string") observed.rpcMethod = body.method;
    response.setHeader("content-type", "application/json");
    if (request.url === "/mcp/authority") {
      const material = JSON.stringify([3, "agenc-desktop-control", endpoint, body.authorizationHash, body.nonce, socketPath]);
      response.end(JSON.stringify({ signature: validProof ? sign(null, Buffer.from(material), keys.privateKey).toString("base64") : Buffer.alloc(64).toString("base64") })); return;
    }
    if (request.headers.authorization !== authorization) { response.writeHead(401); response.end("{}"); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end("{}"); return; }
    if (!Object.hasOwn(body, "id")) { response.writeHead(202); response.end(); return; }
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "private-socket", version: "1" } } : { tools: [] };
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }); servers.push(server);
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); await chmod(socketPath, 0o600);
  const id = randomUUID(); const directory = join(home, "desktop-control-authorities"); await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ version: 2, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }), expiresAt: Date.now() + 600_000, socketPath }), { mode: 0o600 });
  const material = JSON.stringify([2, "agenc-desktop-control", endpoint, createHash("sha256").update(authorization).digest("hex"), 1, socketPath]);
  const config = { name: "agenc-desktop-control", endpoint, localOnly: true, headers: { Authorization: authorization }, desktopAuthority: { id, signature: sign(null, Buffer.from(material), keys.privateKey).toString("base64") } };
  return { config: { ...config, desktopAuthorityGrant: await verifyDesktopAuthority(config, home) }, socketPath, requests, tcpCalls: () => tcpCalls };
}

describe("audited Desktop socket-only HTTP transport", () => {
  it("sends credentials only over the verified private socket and refuses revoked permissions", async () => {
    const f = await fixture();
    const client = await createHttpMCPConnection(f.config); clients.push(client);
    await client.listTools();
    expect(f.requests[0]).toEqual({ path: "/mcp/authority", authorization: undefined });
    expect(f.requests.some(request => request.path === "/mcp" && request.authorization === f.config.headers.Authorization)).toBe(true);
    expect(f.tcpCalls()).toBe(0);
    // The SDK may still finish its initial SSE/initialized request. Assert the
    // refused RPC never arrives, not that unrelated in-flight setup is silent.
    const count = f.requests.filter(request => request.rpcMethod === "tools/list").length;
    await chmod(f.socketPath, 0o666);
    await expect(client.listTools()).rejects.toThrow("private socket authority");
    expect(f.requests.filter(request => request.rpcMethod === "tools/list")).toHaveLength(count); expect(f.tcpCalls()).toBe(0);
    await chmod(f.socketPath, 0o600);
  });
  it("does not transmit authorization or fall back to TCP when live proof is invalid", async () => {
    const f = await fixture(false);
    await expect(createHttpMCPConnection(f.config)).rejects.toThrow("Live Desktop");
    expect(f.requests).toEqual([{ path: "/mcp/authority", authorization: undefined }]);
    expect(f.tcpCalls()).toBe(0);
  });
  it("rechecks cancellation and turn expiry after asynchronous socket preflight", async () => {
    const f = await fixture(); const client = await createHttpMCPConnection(f.config); clients.push(client);
    const checkSocket = authority.assertDesktopSocketBinding;
    for (const abort of [true, false]) {
      let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
      const controller = new AbortController();
      const spy = vi.spyOn(authority, "assertDesktopSocketBinding").mockImplementation(async grant => { await checkSocket(grant); entered(); await paused; });
      let pending!: Promise<unknown>;
      await withLocalMcpAccess(true, async () => {
        pending = withDesktopMcpDispatchGuard(() => {
          if (controller.signal.aborted || !hasLocalMcpAccess()) throw new DesktopMcpPreflightRefusal("cancelled or expired before send");
        }, () => client.callTool({ name: "desktop_state", arguments: {} }));
        await reached;
        if (abort) controller.abort();
      });
      const rejected = expect(pending).rejects.toThrow("cancelled or expired before send");
      release(); await rejected; spy.mockRestore();
    }
    expect(f.requests.filter(request => request.rpcMethod === "tools/call")).toHaveLength(0);
    expect(f.tcpCalls()).toBe(0);
    await expect(client.callTool({ name: "desktop_state", arguments: {} })).rejects.toThrow("currently admitted local");
  });
});
