import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ws", async () => (await import("./helpers/legacy-bridge.js")).fakeWsModule());
import { captureRemoteCliRuntimeContext, legacyBridgeDeniesMethod, runRemoteSlash, startRemoteOn } from "../../src/bin/remote-cli.js";
import { fakeSockets, pairStartResponse } from "./helpers/legacy-bridge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); fakeSockets.length = 0; vi.restoreAllMocks(); vi.useRealTimers(); });

function bridgeContext(prefix: string, environment: Readonly<Record<string, string>>) {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(home, "daemon.cookie"), "c".repeat(64), { mode: 0o600 });
  const context = captureRemoteCliRuntimeContext(Object.freeze({ AGENC_HOME: home, AGENC_REMOTE_AUTH_TOKEN: "fixture-token", ...environment }));
  cleanups.push(async () => { await runRemoteSlash("off", context); rmSync(home, { recursive: true, force: true }); });
  return context;
}

async function fixture() {
  const context = bridgeContext("legacy-authority-", { AGENC_REMOTE_FULL_CONTROL: "1" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => pairStartResponse());
  const started = await startRemoteOn(context);
  expect("box" in started ? started.box : "").toContain("Warning: a paired phone gets full control of this computer's AgenC.");
  const relay = fakeSockets[0]!; relay.readyState = 1; relay.emit("open");
  const send = (id: string, method: string, params: Record<string, unknown> = {}) => relay.emit("message", JSON.stringify({ t: "data", cid: "phone", payload: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }));
  const forwarded = () => (fakeSockets[1]?._queue ?? []).map((raw) => (JSON.parse(raw) as { method: string }).method);
  const refused = () => relay.sent.flatMap((raw) => { const frame = JSON.parse(raw) as { t: string; cid?: string; payload?: string }; if (frame.t !== "data" || !frame.payload) return []; const message = JSON.parse(frame.payload) as { id: string; error?: { data?: { code?: string } } }; return message.error?.data?.code === "REMOTE_METHOD_DENIED" ? [`${frame.cid}:${message.id}`] : []; });
  return { send, forwarded, refused };
}

describe("legacy phone bridge authority", () => {
  it("does not start the bridge unless phone remote control was turned on", async () => {
    const context = bridgeContext("legacy-authority-off-", {});
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network should not be touched"));
    const started = await startRemoteOn(context);
    expect("message" in started ? started.message : "").toMatch(/^Phone remote control is off\./u);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fakeSockets).toHaveLength(0);
  });
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
    expect(fakeSockets[1]?._queue?.[0]).toContain(`"authCookie":"${"c".repeat(64)}"`);
    expect(f.refused().sort()).toEqual(denied.map((_, index) => `phone:deny-${index}`).sort());
  });
  it("classifies methods by family, not only by the exact names it lists", () => {
    for (const method of ["commandExec.resize", "remote.status", "telegram.agents.list", "daemon.shutdown", "session.mcp.addServer"]) expect(legacyBridgeDeniesMethod(method), method).toBe(true);
    for (const method of ["initialize", "agent.create", "session.list", "session.attach", "message.send", "tool.approve", "session.cancelTurn", "session.mcp.status", "session.mcp.disableServer", "routine.list", "auth.whoami", "health.ping"]) expect(legacyBridgeDeniesMethod(method), method).toBe(false);
  });
});
