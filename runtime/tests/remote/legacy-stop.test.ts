import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ sockets: [] as Array<{ readyState: number; emit: (event: string, ...args: unknown[]) => void; terminate: () => void }> }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    constructor() { super(); fake.sockets.push(this); }
    send() {}
    close() { this.terminate(); }
    terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  }
  return { default: Socket };
});
import { captureRemoteCliRuntimeContext, runRemoteSlash, startRemoteOn } from "../../src/bin/remote-cli.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); fake.sockets.length = 0; vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture() {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "legacy-stop-"));
  const context = captureRemoteCliRuntimeContext(Object.freeze({ AGENC_HOME: home, AGENC_REMOTE_AUTH_TOKEN: "fixture-token", AGENC_REMOTE_FULL_CONTROL: "1" }));
  const response = () => new Response(JSON.stringify({ pairingId: "fixture-pair", hostSecret: "fixture-secret", relayUrl: "wss://relay.example", hostTicket: "fixture-ticket", code: "ABCDEFGH", expiresAt: new Date(Date.now() + 180_000).toISOString() }), { status: 200 });
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
  cleanups.push(async () => { await runRemoteSlash("off", context); rmSync(home, { recursive: true, force: true }); });
  await startRemoteOn(context);
  return { home, context, fetcher, response };
}
describe("legacy remote revocation", () => {
  it("checks the cross-process stop marker before forwarding the next frame", async () => {
    const f = await fixture(); const socket = fake.sockets[0]!; socket.readyState = 1; socket.emit("open");
    writeFileSync(join(f.home, "remote", "stopped"), "another-process-revoked", { mode: 0o600 });
    socket.emit("message", JSON.stringify({ t: "data", cid: "phone", payload: JSON.stringify({ jsonrpc: "2.0", id: "request", method: "initialize", params: {} }) }));
    expect(socket.readyState).toBe(3); expect(fake.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000); expect(fake.sockets).toHaveLength(1);
  });
  it("off invalidates a ticket refresh that resolves after the bridge closed", async () => {
    const f = await fixture(); let resolve!: (response: Response) => void;
    f.fetcher.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    fake.sockets[0]!.terminate();
    await runRemoteSlash("off", f.context);
    resolve(f.response()); await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.sockets).toHaveLength(1);
  });
});
