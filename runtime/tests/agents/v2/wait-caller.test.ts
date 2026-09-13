import { afterEach, describe, expect, it, vi } from "vitest";
import { mkSession } from "../../fixtures.js";
import type { Session } from "../../../src/session/session.js";
import type { LiveAgent } from "../../../src/agents/control.js";
import { bindLiveAgentSession } from "../../../src/agents/live-session.js";
import { signSessionId } from "../../../src/agents/_deps/filesystem-args.js";
import type { MultiAgentV2Options } from "../../../src/agents/v2/common.js";
import { createWaitAgentTool } from "../../../src/agents/v2/wait.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

function fixture() {
  const rootFixture = mkSession();
  const childFixture = mkSession();
  const root = rootFixture.session;
  const child = childFixture.session;
  Object.defineProperty(root, "conversationId", { value: "wait-root" });
  Object.defineProperty(child, "conversationId", { value: "wait-implementation" });
  const live = {
    agentId: child.conversationId,
    agentPath: "/root/implementation",
    nickname: "implementation",
    role: { name: "worker" },
    abortController: new AbortController(),
  } as LiveAgent;
  const liveById = new Map([[live.agentId, live]]);
  const revoke = bindLiveAgentSession(live, child);
  cleanup.push(async () => {
    revoke();
    await child.shutdown();
    await root.shutdown();
  });
  const ensureAgentControl = vi.fn((_session: Session) => ({
    control: {
      getLive: (id: string) => liveById.get(id),
      registerSessionRoot: vi.fn(),
      listAgents: () => [],
    },
    registry: {},
  }));
  const opts = {
    getSession: () => root,
    workspace: {},
    ensureAgentControl,
  } as unknown as MultiAgentV2Options;
  const args = {
    __agencSessionId: live.agentId,
    __agencSessionIdSig: signSessionId(live.agentId),
  };
  return {
    root, child, live, liveById, revoke, ensureAgentControl, args,
    rootEvents: rootFixture.events,
    childEvents: childFixture.events,
    tool: createWaitAgentTool(opts),
  };
}

function notify(session: Session, content: string): void {
  session.mailbox.send({
    author: "/root/implementation/worker",
    recipient: session.conversationId,
    content,
    triggerTurn: true,
    direction: "up",
  });
}

async function invoke(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  const args = { ...f.args, ...extra };
  if (extra.__abortSignal !== undefined) {
    Object.defineProperty(args, "__abortSignal", { value: extra.__abortSignal, enumerable: false });
  }
  const result = await f.tool.execute(args, {} as never);
  return { ...result, body: JSON.parse(result.content) as Record<string, unknown> };
}

describe("wait_agent authenticated caller mailbox", () => {
  it("drains only the nested caller's real mailbox on both worker rounds", async () => {
    const f = fixture();
    notify(f.root, "outer session private result");
    const rootWait = vi.spyOn(f.root, "waitForMailboxChange");
    for (const round of [1, 2]) {
      notify(f.child, `worker round ${round} finished`);
      const result = await invoke(f);
      expect(result.isError).not.toBe(true);
      expect(result.body.timed_out).toBe(false);
      expect(JSON.stringify(result.body.updates)).toContain(`worker round ${round} finished`);
      expect(result.content).not.toContain("outer session private result");
      expect(f.child.mailbox.hasPending()).toBe(false);
      expect(f.root.mailbox.hasPending()).toBe(true);
    }
    expect(rootWait).not.toHaveBeenCalled();
    expect(f.ensureAgentControl.mock.calls.every(([session]) => session === f.root)).toBe(true);
    expect(f.rootEvents.some((event) => event.msg.type === "collab_waiting_begin")).toBe(false);
    expect(f.childEvents.filter((event) => event.msg.type === "collab_waiting_end")).toHaveLength(2);
  });

  it("wakes a pending nested wait when its worker sends a receipt", async () => {
    const f = fixture();
    const abort = new AbortController();
    const rootWait = vi.spyOn(f.root, "waitForMailboxChange");
    const childWait = vi.spyOn(f.child, "waitForMailboxChange");
    const pending = invoke(f, { __abortSignal: abort.signal });
    notify(f.child, "new worker completion");
    // Abort only bounds the broken baseline, which waits on the empty root.
    // The correct Session wait has already settled from this notification.
    await Promise.resolve();
    abort.abort("test finished delivering receipt");
    const result = await pending;
    expect(result.body).toMatchObject({ timed_out: false });
    expect(JSON.stringify(result.body.updates)).toContain("new worker completion");
    expect(childWait).toHaveBeenCalledOnce();
    expect(rootWait).not.toHaveBeenCalled();
  });

  it.each(["forged", "missing", "copied", "revoked", "aborted", "closing", "changed_path"] as const)(
    "refuses %s caller authority without reading either mailbox",
    async (kind) => {
      const f = fixture();
      notify(f.root, "outer private");
      notify(f.child, "child private");
      if (kind === "forged") f.args.__agencSessionIdSig = "forged";
      if (kind === "missing") f.liveById.delete(f.live.agentId);
      if (kind === "copied") f.liveById.set(f.live.agentId, { ...f.live });
      if (kind === "revoked") f.revoke();
      if (kind === "aborted") f.live.abortController.abort();
      if (kind === "closing") Object.defineProperty(f.child, "isShuttingDown", { value: true });
      if (kind === "changed_path") Object.defineProperty(f.live, "agentPath", { value: "/root/sibling" });
      const result = await invoke(f);
      expect(result.isError).toBe(true);
      expect(result.content).not.toContain("private");
      expect(f.root.mailbox.hasPending()).toBe(true);
      expect(f.child.mailbox.hasPending()).toBe(true);
    },
  );

  it.each(["revoked", "replaced"] as const)("does not drain a caller %s while the wait is pending", async (kind) => {
    const f = fixture();
    // Queue the outer result too so the old root-bound implementation also
    // reaches its asynchronous drain boundary without a timer.
    notify(f.root, "outer private");
    const pending = invoke(f);
    if (kind === "revoked") f.revoke();
    else f.liveById.set(f.live.agentId, { ...f.live });
    notify(f.child, "child private");
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(f.root.mailbox.hasPending()).toBe(true);
    expect(f.child.mailbox.hasPending()).toBe(true);
  });

  it("uses the caller's timeout configuration and turn budget without charging the root", async () => {
    const f = fixture();
    Object.defineProperty(f.child, "config", {
      value: {
        ...f.child.config,
        multiAgentV2: {
          ...f.child.config.multiAgentV2,
          minWaitTimeoutMs: 1,
          defaultWaitTimeoutMs: 7,
          maxWaitTimeoutMs: 25,
          maxConsecutiveWaitTimeouts: 2,
        },
      },
    });
    const childWait = vi.spyOn(f.child, "waitForMailboxChange").mockResolvedValue(false);
    vi.spyOn(f.root, "waitForMailboxChange").mockResolvedValue(false);
    await f.child.spawnTask({ subId: "child-A", kind: "regular" });
    await f.root.spawnTask({ subId: "root-A", kind: "regular" });
    expect((await invoke(f)).body).toMatchObject({ consecutive_timeouts: 1, waited_ms: 7 });
    expect(childWait).toHaveBeenLastCalledWith(7, undefined, undefined);
    const outer = await f.tool.execute({}, {} as never);
    expect(JSON.parse(outer.content)).toMatchObject({ consecutive_timeouts: 1, waited_ms: 30_000 });
    const second = await invoke(f, { timeout_ms: 100 });
    expect(second.isError).toBe(true);
    expect(second.body).toMatchObject({ consecutive_timeouts: 2, waited_ms: 32 });
    expect(second.content).toContain("timeout_ms up to 25");
    await f.child.onTaskFinished("child-A");
    await f.child.spawnTask({ subId: "child-B", kind: "regular" });
    expect((await invoke(f)).body).toMatchObject({ consecutive_timeouts: 1, waited_ms: 7 });
    expect(f.ensureAgentControl.mock.calls.every(([session]) => session === f.root)).toBe(true);
  });
});
