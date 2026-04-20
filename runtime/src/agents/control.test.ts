import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentControl,
  MAX_AGENT_DEPTH,
  MaxDepthExceededError,
} from "./control.js";
import { AgentRegistry, type AgentMetadata } from "./registry.js";
import { _resetNicknamePoolForTesting } from "./role.js";

function stubSession() {
  const emitted: unknown[] = [];
  return {
    emit: (e: unknown) => {
      emitted.push(e);
    },
    eventLog: {
      emit: (e: unknown) => {
        emitted.push(e);
        return e;
      },
    },
    nextInternalSubId: () => `sub-${emitted.length}`,
    childInboxes: new Map(),
    _emitted: emitted,
  } as unknown as ConstructorParameters<typeof AgentControl>[0]["session"];
}

beforeEach(() => {
  _resetNicknamePoolForTesting();
});

afterEach(() => {
  _resetNicknamePoolForTesting();
});

describe("AgentControl", () => {
  it("spawn() produces a LiveAgent with allocated path + nickname", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    expect(live.agentPath.startsWith("/root/")).toBe(true);
    expect(live.nickname).toBeDefined();
    expect(live.depth).toBe(1);
  });

  it("I-1: depth at cap is rejected (codex `>=` semantics)", async () => {
    // maxDepth=2 means childDepth=2 rejects; depth=1 is the last
    // accepted level. Matches codex `depth >= config.agent_max_depth`.
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const first = await control.spawn({ parentPath: "/root" });
    expect(first.depth).toBe(1);
    await expect(
      control.spawn({ parentPath: first.agentPath }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("I-1: depth = cap-1 is accepted", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 3 });
    const d1 = await control.spawn({ parentPath: "/root" });
    const d2 = await control.spawn({ parentPath: d1.agentPath });
    expect(d2.depth).toBe(2); // cap - 1
    await expect(
      control.spawn({ parentPath: d2.agentPath }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("AgentControlOpts.maxDepth override is honored", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 1 });
    // cap=1 matches codex default: root (depth 0) may not spawn.
    await expect(
      control.spawn({ parentPath: "/root" }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("MAX_AGENT_DEPTH default is 4", () => {
    expect(MAX_AGENT_DEPTH).toBe(4);
  });

  it("interrupt() cascades to descendants and fires AbortController", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    control.interrupt(parent.agentId, "user_interrupt");
    expect(parent.abortController.signal.aborted).toBe(true);
    expect(child.abortController.signal.aborted).toBe(true);
  });

  it("shutdown() clears live + registry + childInboxes", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    expect(control.listLive().length).toBe(1);
    await control.shutdown(live.agentId);
    expect(control.listLive().length).toBe(0);
    expect(registry.activeCount).toBe(0);
  });

  it("shutdownAll() cascades every live agent", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const a = await control.spawn({ parentPath: "/root" });
    const b = await control.spawn({ parentPath: "/root" });
    expect(control.listLive().length).toBe(2);
    await control.shutdownAll("session_shutdown");
    expect(control.listLive().length).toBe(0);
    expect(a.abortController.signal.aborted).toBe(true);
    expect(b.abortController.signal.aborted).toBe(true);
  });

  it("descendantsOf() filters by path prefix", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    const other = await control.spawn({ parentPath: "/root" });
    const descendants = control.descendantsOf(parent.agentPath);
    expect(descendants.map((d) => d.agentId)).toEqual([child.agentId]);
    void other;
  });

  it("resume() registers unknown metadata and returns a LiveAgent", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const metadata: AgentMetadata = {
      agentId: "thread-resume-1",
      agentPath: "/root/scout",
      agentNickname: "scout",
      agentRole: "explorer",
      depth: 1,
    };
    const live = await control.resume({ parentPath: "/root", metadata });
    expect(live).not.toBeNull();
    expect(live!.agentId).toBe("thread-resume-1");
    expect(live!.agentPath).toBe("/root/scout");
    expect(live!.nickname).toBe("scout");
    expect(live!.depth).toBe(1);
    expect(live!.role.name).toBe("explorer");
    expect(registry.agentMetadataForThread("thread-resume-1")).toBeDefined();
    expect(registry.activeCount).toBe(1);
  });

  it("resume() is idempotent for an already-live path", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const spawned = await control.spawn({ parentPath: "/root" });
    const metadata: AgentMetadata = {
      agentId: spawned.agentId,
      agentPath: spawned.agentPath,
      agentNickname: spawned.nickname,
      agentRole: spawned.role.name,
      depth: spawned.depth,
    };
    const resumed = await control.resume({
      parentPath: "/root",
      metadata,
    });
    expect(resumed).toBe(spawned);
    expect(registry.activeCount).toBe(1);
  });

  it("resume() respects I-1 depth cap", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const metadata: AgentMetadata = {
      agentId: "thread-too-deep",
      agentPath: "/root/a/b/c",
      agentNickname: "too-deep",
      agentRole: "default",
      depth: 3,
    };
    await expect(
      control.resume({ parentPath: "/root/a/b", metadata }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("resume() attaches the upInbox to session.childInboxes", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const metadata: AgentMetadata = {
      agentId: "thread-attach-1",
      agentPath: "/root/attach",
      agentNickname: "attach",
      agentRole: "default",
      depth: 1,
    };
    const live = await control.resume({ parentPath: "/root", metadata });
    expect(live).not.toBeNull();
    const inboxes = (session as unknown as { childInboxes: Map<string, unknown> })
      .childInboxes;
    expect(inboxes.get("thread-attach-1")).toBe(live!.upInbox);
  });

  it("resume() emits an agent_resumed warning", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const metadata: AgentMetadata = {
      agentId: "thread-emit-1",
      agentPath: "/root/emit",
      agentNickname: "emit",
      agentRole: "default",
      depth: 1,
    };
    await control.resume({ parentPath: "/root", metadata });
    const emitted = (session as unknown as { _emitted: Array<{ msg: { type: string; payload?: { cause?: string; message?: string } } }> })
      ._emitted;
    const resumed = emitted.find(
      (e) =>
        e?.msg?.type === "warning" && e?.msg?.payload?.cause === "agent_resumed",
    );
    expect(resumed).toBeDefined();
    expect(resumed!.msg.payload!.message).toContain("/root/emit");
    expect(resumed!.msg.payload!.message).toContain("emit");
  });
});
