import { afterEach, describe, expect, it, vi } from "vitest";
import { AgenCDaemonJsonRpcDispatcher, type AgenCDaemonDispatcherOptions } from "../../src/app-server/daemon-dispatcher.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";

const dispatchers: AgenCDaemonJsonRpcDispatcher[] = [];
afterEach(async () => { for (const d of dispatchers.splice(0)) await d.close().catch(() => {}); });
const rpc = (id: string, method: string, params: JsonObject = {}): JsonObject => ({ jsonrpc: "2.0", id, method, params: method === "agent.create" ? { cwd: process.cwd(), ...params } : params });
const freshPrint = (): JsonObject => ({ objective: "test", runtimeOptions: { ...resolveAgentRuntimeOptions({}), nonInteractive: true }, metadata: { source: "agenc.prompt", mode: "one-shot" } });
function fixture() {
  let next = 0;
  const manager = {
    createAgent: vi.fn(async () => ({ agentId: `agent-${++next}`, sessionId: `session-${next}` })),
    stopAgent: vi.fn(async (p: { agentId: string; reason?: string }) => ({ agentId: p.agentId, status: "stopped" })),
  };
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: manager as unknown as AgenCDaemonDispatcherOptions["agentManager"] });
  dispatchers.push(dispatcher);
  const connect = async () => {
    const c = dispatcher.createConnection({ localUnix: true, sendNotification: () => {} });
    expect(await c.dispatch(rpc("init", "initialize", { protocolVersion: "1.30.0" }))).toHaveProperty("result");
    return c;
  };
  return { manager, dispatcher, connect };
}

describe("ordinary print connection ownership", () => {
  it("stops its completed create on connection drop through the normal stop path", async () => {
    const h = fixture(), c = await h.connect();
    expect(await c.dispatch(rpc("create", "agent.create", freshPrint()))).toHaveProperty("result.agentId", "agent-1");
    await c.close(); await c.close();
    expect(h.manager.stopAgent).toHaveBeenCalledExactlyOnceWith({ agentId: "agent-1", reason: "one_shot_cancelled" });
  });
  it("joins stop before connection cleanup finishes", async () => {
    const h = fixture(), c = await h.connect(), release = Promise.withResolvers<void>();
    await c.dispatch(rpc("create", "agent.create", freshPrint()));
    h.manager.stopAgent.mockImplementation(async p => { await release.promise; return { agentId: p.agentId, status: "stopped" }; });
    let closed = false; const closing = c.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(h.manager.stopAgent).toHaveBeenCalledOnce()); expect(closed).toBe(false);
    release.resolve(); await closing; expect(closed).toBe(true);
  });
  it("stops a create that resolves after disconnect instead of losing the new agent", async () => {
    const h = fixture(), c = await h.connect();
    const release = Promise.withResolvers<{ agentId: string; sessionId: string }>();
    h.manager.createAgent.mockImplementation(() => release.promise);
    const creating = c.dispatch(rpc("create", "agent.create", freshPrint()));
    await vi.waitFor(() => expect(h.manager.createAgent).toHaveBeenCalledOnce());
    let closed = false; const closing = c.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
    release.resolve({ agentId: "late", sessionId: "late-session" });
    await closing; expect(await creating).toHaveProperty("error");
    expect(h.manager.stopAgent).toHaveBeenCalledExactlyOnceWith({ agentId: "late", reason: "one_shot_cancelled" });
  });
  it("cleans up rejected creation without stopping an unrelated agent", async () => {
    const h = fixture(), c = await h.connect(); h.manager.createAgent.mockRejectedValue(new Error("creation failed"));
    expect(await c.dispatch(rpc("create", "agent.create", freshPrint()))).toHaveProperty("error");
    await c.close(); expect(h.manager.stopAgent).not.toHaveBeenCalled();
  });
  it("does not cancel another connection's print agent", async () => {
    const h = fixture(), owner = await h.connect(), other = await h.connect();
    await owner.dispatch(rpc("create", "agent.create", freshPrint())); await other.close();
    expect(h.manager.stopAgent).not.toHaveBeenCalled(); await owner.close(); expect(h.manager.stopAgent).toHaveBeenCalledOnce();
  });
  it("forgets normal completion even when stop came through a control connection", async () => {
    const h = fixture(), owner = await h.connect(), control = await h.connect();
    await owner.dispatch(rpc("create", "agent.create", freshPrint()));
    await control.dispatch(rpc("stop", "agent.stop", { agentId: "agent-1", reason: "one_shot_complete" }));
    await owner.close(); await control.close();
    expect(h.manager.stopAgent).toHaveBeenCalledExactlyOnceWith({ agentId: "agent-1", reason: "one_shot_complete" });
  });
  it.each([
    { objective: "interactive", runtimeOptions: { ...resolveAgentRuntimeOptions({}), nonInteractive: false }, metadata: { source: "agenc.prompt", mode: "one-shot" } },
    { objective: "detached", runtimeOptions: { ...resolveAgentRuntimeOptions({}), nonInteractive: true } },
    { objective: "other", runtimeOptions: { ...resolveAgentRuntimeOptions({}), nonInteractive: true }, metadata: { source: "other", mode: "one-shot" } },
    { ...freshPrint(), resumeSessionId: "existing", resumeRolloutPath: "/tmp/rollout.jsonl", resumeSourceProof: { dev: "1", ino: "2", size: "3", sha256: "a".repeat(64), cwdDev: "1", cwdIno: "4" } },
  ])("keeps interactive, detached and resumed lifetimes unchanged: %j", async params => {
    const h = fixture(), c = await h.connect();
    expect(await c.dispatch(rpc("create", "agent.create", params))).toHaveProperty("result");
    await c.close(); expect(h.manager.stopAgent).not.toHaveBeenCalled();
  });
  it("attempts every owned stop and reports cleanup failure", async () => {
    const h = fixture(), c = await h.connect();
    await c.dispatch(rpc("create1", "agent.create", freshPrint())); await c.dispatch(rpc("create2", "agent.create", freshPrint()));
    h.manager.stopAgent.mockRejectedValueOnce(new Error("containment stop failed"));
    await expect(c.close()).rejects.toThrow("daemon connection cleanup failed"); expect(h.manager.stopAgent).toHaveBeenCalledTimes(2);
  });
});
