import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ sockets: [] as Array<{ url: string; readyState: number; sent: string[]; emit: (event: string, ...args: unknown[]) => void; terminate: () => void; _queue?: string[] }> }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    constructor(readonly url: string) { super(); fake.sockets.push(this as never); }
    send(value: string) { this.sent.push(value); }
    close() { this.terminate(); }
    terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  }
  return { default: Socket };
});
import { captureRemoteCliRuntimeContext, legacyBridgeDeniesMethod, runRemoteSlash, startRemoteOn } from "../../src/bin/remote-cli.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); fake.sockets.length = 0; vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture() {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "legacy-authority-"));
  writeFileSync(join(home, "daemon.cookie"), "c".repeat(64), { mode: 0o600 });
  const context = captureRemoteCliRuntimeContext(Object.freeze({ AGENC_HOME: home, AGENC_REMOTE_AUTH_TOKEN: "fixture-token" }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ pairingId: "fixture-pair", hostSecret: "fixture-secret", relayUrl: "wss://relay.example", hostTicket: "fixture-ticket", code: "ABCDEFGH", expiresAt: new Date(Date.now() + 180_000).toISOString() }), { status: 200 }));
  cleanups.push(async () => { await runRemoteSlash("off", context); rmSync(home, { recursive: true, force: true }); });
  await startRemoteOn(context);
  const relay = fake.sockets[0]!; relay.readyState = 1; relay.emit("open");
  const send = (id: string, method: string, params: Record<string, unknown> = {}) => relay.emit("message", JSON.stringify({ t: "data", cid: "phone", payload: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }));
  const forwarded = () => (fake.sockets[1]?._queue ?? []).map((raw) => (JSON.parse(raw) as { method: string }).method);
  const refused = () => relay.sent.flatMap((raw) => { const frame = JSON.parse(raw) as { t: string; cid?: string; payload?: string }; if (frame.t !== "data" || !frame.payload) return []; const message = JSON.parse(frame.payload) as { id: string; error?: { data?: { code?: string } } }; return message.error?.data?.code === "REMOTE_METHOD_DENIED" ? [`${frame.cid}:${message.id}`] : []; });
  return { send, forwarded, refused };
}

describe("legacy phone bridge authority", () => {
  it("keeps daemon, account, trust, configuration, MCP, routine and shell administration host-local", async () => {
    const f = await fixture();
    f.send("init", "initialize", { protocol: { version: "1.0.0" }, capabilities: {} });
    const denied: Array<[string, Record<string, unknown>]> = [
      ["daemon.shutdown", {}], ["daemon.reload", {}], ["auth.logout", {}], ["auth.login", {}],
      ["project.trust", { cwd: "/" }], ["plugin.settings.set", {}], ["plugin.settings.reset", {}],
      ["session.applyConfig", { sessionId: "s" }], ["session.permissions.mutateRule", { sessionId: "s" }], ["session.hooks.setDisabled", { sessionId: "s" }],
      ["session.mcp.addServer", { sessionId: "s", name: "x", command: "/tmp/x" }], ["session.mcp.enableServer", { sessionId: "s", name: "x" }],
      ["routine.create", {}], ["routine.run", {}], ["routine.delete", {}],
      ["commandExec.start", { command: "sh" }], ["commandExec.write", {}], ["remote.pair.begin", {}], ["telegram.configure", {}],
    ];
    denied.forEach(([method, params], index) => f.send(`deny-${index}`, method, params));
    f.send("list", "agent.list", {});
    f.send("send", "message.send", { sessionId: "s", content: "hi" });
    expect(f.forwarded()).toEqual(["initialize", "agent.list", "message.send"]);
    expect(fake.sockets[1]?._queue?.[0]).toContain(`"authCookie":"${"c".repeat(64)}"`);
    expect(f.refused().sort()).toEqual(denied.map((_, index) => `phone:deny-${index}`).sort());
  });
  it("classifies methods by family, not only by the exact names it lists", () => {
    for (const method of ["commandExec.resize", "remote.status", "telegram.agents.list", "daemon.shutdown", "session.mcp.addServer"]) expect(legacyBridgeDeniesMethod(method), method).toBe(true);
    for (const method of ["initialize", "agent.create", "session.list", "session.attach", "message.send", "tool.approve", "session.cancelTurn", "session.mcp.status", "session.mcp.disableServer", "routine.list", "auth.whoami", "health.ping"]) expect(legacyBridgeDeniesMethod(method), method).toBe(false);
  });
});
