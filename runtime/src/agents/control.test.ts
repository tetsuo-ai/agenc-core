import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentControl,
  AgentReferenceUnresolvedError,
  MAX_AGENT_DEPTH,
  MaxDepthExceededError,
  ThreadNotFoundError,
  renderInputPreview,
} from "./control.js";
import { AgentRegistry, type AgentMetadata } from "./registry.js";
import { _resetNicknamePoolForTesting } from "./role.js";
import { RolloutStore } from "../session/rollout-store.js";
import { SimpleMailbox, type InterAgentCommunication } from "../session/session.js";

let agencHome = "";
let originalAgencHome = "";

function stubSession(opts: {
  rolloutStore?: RolloutStore | null;
  conversationId?: string;
} = {}) {
  const emitted: unknown[] = [];
  const mailbox = new SimpleMailbox<InterAgentCommunication & { seq: number }>();
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
    mailbox,
    rolloutStore: opts.rolloutStore ?? null,
    conversationId: opts.conversationId ?? "session-test",
    _emitted: emitted,
  } as unknown as ConstructorParameters<typeof AgentControl>[0]["session"];
}

function openRolloutStore(opts: {
  cwd: string;
  sessionId: string;
  resume?: boolean;
}): RolloutStore {
  const store = new RolloutStore({
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    agencVersion: "0.2.0",
    ...(opts.resume ? { resume: true } : {}),
  });
  store.open({
    sessionId: opts.sessionId,
    timestamp: new Date().toISOString(),
    cwd: opts.cwd,
    originator: "control-test",
    agencVersion: "0.2.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-control-home-"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = agencHome;
  _resetNicknamePoolForTesting();
});

afterEach(() => {
  _resetNicknamePoolForTesting();
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  if (agencHome) rmSync(agencHome, { recursive: true, force: true });
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

  it("spawn() can use an explicit task-name path segment", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({
      parentPath: "/root",
      agentName: "task_3",
    });
    expect(live.agentPath).toBe("/root/task_3");
    expect(live.metadata.agentPath).toBe("/root/task_3");
  });

  it("I-1: depth beyond cap is rejected", async () => {
    // maxDepth=2 means depth=2 is accepted and depth=3 rejects.
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const first = await control.spawn({ parentPath: "/root" });
    expect(first.depth).toBe(1);
    const second = await control.spawn({ parentPath: first.agentPath });
    expect(second.depth).toBe(2);
    await expect(
      control.spawn({ parentPath: second.agentPath }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("I-1: depth = cap is accepted", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 3 });
    const d1 = await control.spawn({ parentPath: "/root" });
    const d2 = await control.spawn({ parentPath: d1.agentPath });
    const d3 = await control.spawn({ parentPath: d2.agentPath });
    expect(d3.depth).toBe(3);
    await expect(
      control.spawn({ parentPath: d3.agentPath }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("AgentControlOpts.maxDepth override is honored", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 0 });
    // cap=0 permits only the root session.
    await expect(
      control.spawn({ parentPath: "/root" }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("MAX_AGENT_DEPTH default is 1", () => {
    expect(MAX_AGENT_DEPTH).toBe(1);
  });

  it("reads agent_max_depth from the session config when no explicit override is provided", async () => {
    const session = stubSession() as ReturnType<typeof stubSession> & {
      config: { agent_max_depth: number };
    };
    session.config = { agent_max_depth: 2 };
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    expect(child.depth).toBe(2);
  });

  it("interrupt() cascades to descendants and fires AbortController", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    control.interrupt(parent.agentId, "user_interrupt");
    expect(parent.abortController.signal.aborted).toBe(true);
    expect(child.abortController.signal.aborted).toBe(true);
  });

  it("shutdown() clears live + registry + childInboxes", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
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
    const control = new AgentControl({ session, registry, maxDepth: 2 });
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

  // ───────────────────────────────────────────────────────────
  // Priority-1 routing (sendInput / appendMessage / IAC)
  // ───────────────────────────────────────────────────────────

  it("sendInput() routes to the child's downInbox + records preview", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    await control.sendInput(live.agentId, "hello from parent\nsecond line");
    const drained = live.downInbox.drain();
    expect(drained.length).toBe(1);
    const msg = drained[0]!;
    expect((msg as { triggerTurn: boolean }).triggerTurn).toBe(true);
    expect((msg as { content: string }).content).toContain("hello from parent");
    const meta = registry.agentMetadataForThread(live.agentId);
    expect(meta?.lastTaskMessage).toBe("hello from parent");
  });

  it("sendInput() throws ThreadNotFoundError for unknown thread id", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    await expect(control.sendInput("missing", "x")).rejects.toBeInstanceOf(
      ThreadNotFoundError,
    );
  });

  it("appendMessage() sends non-turn-triggering message", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    await control.appendMessage(live.agentId, "context blob");
    const drained = live.downInbox.drain();
    expect(drained.length).toBe(1);
    const msg = drained[0]!;
    expect((msg as { triggerTurn: boolean }).triggerTurn).toBe(false);
    expect((msg as { content: string }).content).toBe("context blob");
    // appendMessage does NOT update lastTaskMessage (AgenC behavior).
    const meta = registry.agentMetadataForThread(live.agentId);
    expect(meta?.lastTaskMessage).toBeUndefined();
  });

  it("sendInterAgentCommunication() updates lastTaskMessage", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    await control.sendInterAgentCommunication(live.agentId, {
      author: "/root",
      recipient: live.agentPath,
      content: "iac payload",
      triggerTurn: false,
    });
    const drained = live.downInbox.drain();
    expect(drained.length).toBe(1);
    const msg = drained[0]! as { triggerTurn: boolean; content: string };
    expect(msg.triggerTurn).toBe(false);
    expect(msg.content).toBe("iac payload");
    const meta = registry.agentMetadataForThread(live.agentId);
    expect(meta?.lastTaskMessage).toBe("iac payload");
  });

  it("sendInterAgentCommunication() can queue a message to the root session", async () => {
    const session = stubSession({ conversationId: "root-thread" });
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    control.registerSessionRoot("root-thread");
    await control.sendInterAgentCommunication("root-thread", {
      author: "/root/task_3",
      recipient: "/root",
      content: "final answer",
      triggerTurn: true,
    });
    const drained = session.mailbox.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      author: "/root/task_3",
      recipient: "/root",
      content: "final answer",
      triggerTurn: true,
    });
  });

  // ───────────────────────────────────────────────────────────
  // Priority-2 metadata + subtree queries
  // ───────────────────────────────────────────────────────────

  it("getAgentMetadata() returns registry metadata", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    const meta = control.getAgentMetadata(live.agentId);
    expect(meta).toBeDefined();
    expect(meta!.agentPath).toBe(live.agentPath);
    expect(meta!.depth).toBe(1);
  });

  it("listLiveAgentSubtreeThreadIds() returns self + descendants", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    const sub = control.listLiveAgentSubtreeThreadIds(parent.agentId);
    expect(sub).toContain(parent.agentId);
    expect(sub).toContain(child.agentId);
    expect(sub.length).toBe(2);
  });

  it("listAgents() filters by role name", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    // Don't register root — we want to assert the filter picks exactly
    // the one explorer child, not the synthetic root entry.
    await control.spawn({ parentPath: "/root", roleName: "explorer" });
    await control.spawn({ parentPath: "/root", roleName: "worker" });
    const explorers = control.listAgents({ roleName: "explorer" });
    expect(explorers.every((a) => a.agentName !== "/root")).toBe(true);
    expect(explorers.length).toBe(1);
  });

  it("listAgents() applies pathPrefix filter", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    control.registerSessionRoot("root-id");
    const p = await control.spawn({ parentPath: "/root" });
    await control.spawn({ parentPath: p.agentPath });
    const scoped = control.listAgents({ pathPrefix: p.agentPath });
    // Prefix excludes /root.
    expect(scoped.every((a) => a.agentName !== "/root")).toBe(true);
    expect(scoped.length).toBeGreaterThanOrEqual(2);
  });

  it("getTotalTokenUsage() aggregates live child usage", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const child = await control.spawn({ parentPath: "/root" });
    control.recordAgentUsage(child.agentId, {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
    const usage = control.getTotalTokenUsage();
    expect(usage.inputTokens).toBe(11);
    expect(usage.outputTokens).toBe(7);
    expect(usage.totalTokens).toBe(18);
  });

  it("formatEnvironmentContextSubagents() produces a textual subtree", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    const text = control.formatEnvironmentContextSubagents(parent.agentId);
    expect(text).toContain(child.agentPath);
    expect(text).toContain(child.nickname);
  });

  it("resolveAgentReference() resolves @nickname to a live agent", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    const id = control.resolveAgentReference({
      reference: `@${live.nickname}`,
    });
    expect(id).toBe(live.agentId);
  });

  it("resolveAgentReference() throws when reference is unknown", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    await control.spawn({ parentPath: "/root" });
    expect(() =>
      control.resolveAgentReference({ reference: "@nobody" }),
    ).toThrow(AgentReferenceUnresolvedError);
  });

  it("getAgentConfigSnapshot() returns a compact snapshot", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root", roleName: "explorer" });
    const snap = control.getAgentConfigSnapshot(live.agentId);
    expect(snap).toBeDefined();
    expect(snap!.threadId).toBe(live.agentId);
    expect(snap!.agentRole).toBe("explorer");
    expect(snap!.depth).toBe(1);
  });

  it("registerSessionRoot() lets listAgents include /root", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    // Before register: listAgents omits /root.
    const before = control.listAgents();
    expect(before.some((a) => a.agentName === "/root")).toBe(false);
    control.registerSessionRoot("root-1");
    const after = control.listAgents();
    expect(after.some((a) => a.agentName === "/root")).toBe(true);
  });

  // ───────────────────────────────────────────────────────────
  // Priority-3 completion watcher + rollout resume
  // ───────────────────────────────────────────────────────────

  it("maybeStartCompletionWatcher() emits IAC to parent on child completion", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    control.maybeStartCompletionWatcher({
      childThreadId: child.agentId,
      parentThreadId: parent.agentId,
    });
    child.status.markCompleted("turn-1", "done");
    // Give the microtask/watcher a chance to flush.
    await new Promise<void>((r) => setTimeout(r, 10));
    const drained = parent.downInbox.drain();
    expect(drained.length).toBeGreaterThanOrEqual(1);
    const msg = drained[0]! as { content: string; metadata?: { kind?: string } };
    expect(msg.content).toBe(
      `<subagent_notification>\n{"agent_path":"${child.agentPath}","status":{"completed":"done"}}\n</subagent_notification>`,
    );
    expect(msg.metadata?.kind).toBe("subagent_notification");
  });

  it("resumeAgentFromRollout() reopens open descendants after shutdown", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "resume-open-descendants",
    });
    try {
      const session = stubSession({ rolloutStore });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 3 });
      const root = await control.spawn({ parentPath: "/root" });
      const child = await control.spawn({ parentPath: root.agentPath });
      const grandchild = await control.spawn({ parentPath: child.agentPath });
      await control.shutdownAll("manager_shutdown");

      const result = await control.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(3);
      expect(result.rootLive).not.toBeNull();
      expect(result.rootLive!.agentId).toBe(root.agentId);
      expect(control.getLive(child.agentId)?.agentPath).toBe(child.agentPath);
      expect(control.getLive(grandchild.agentId)?.agentPath).toBe(
        grandchild.agentPath,
      );
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumeAgentFromRollout() restores descendants on a fresh control plane restart", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const sessionId = "resume-fresh-control-plane";
    const originalRolloutStore = openRolloutStore({
      cwd,
      sessionId,
    });
    let resumedRolloutStore: RolloutStore | null = null;
    try {
      const originalSession = stubSession({
        rolloutStore: originalRolloutStore,
        conversationId: sessionId,
      });
      const originalRegistry = new AgentRegistry();
      const originalControl = new AgentControl({
        session: originalSession,
        registry: originalRegistry,
        maxDepth: 3,
      });
      const root = await originalControl.spawn({ parentPath: "/root" });
      const child = await originalControl.spawn({ parentPath: root.agentPath });
      const grandchild = await originalControl.spawn({
        parentPath: child.agentPath,
      });

      await originalControl.shutdownAll("manager_shutdown");
      originalRolloutStore.close();

      resumedRolloutStore = openRolloutStore({
        cwd,
        sessionId,
        resume: true,
      });
      const resumedSession = stubSession({
        rolloutStore: resumedRolloutStore,
        conversationId: sessionId,
      });
      const resumedRegistry = new AgentRegistry();
      const resumedControl = new AgentControl({
        session: resumedSession,
        registry: resumedRegistry,
        maxDepth: 3,
      });

      const result = await resumedControl.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(3);
      expect(result.rootLive?.agentId).toBe(root.agentId);
      expect(resumedControl.getLive(child.agentId)?.agentPath).toBe(
        child.agentPath,
      );
      expect(resumedControl.getLive(grandchild.agentId)?.agentPath).toBe(
        grandchild.agentPath,
      );
    } finally {
      originalRolloutStore.close();
      resumedRolloutStore?.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumeAgentFromRollout() skips descendants beneath a closed child", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "resume-skips-closed-child",
    });
    try {
      const session = stubSession({ rolloutStore });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 3 });
      const root = await control.spawn({ parentPath: "/root" });
      const child = await control.spawn({ parentPath: root.agentPath });
      const grandchild = await control.spawn({ parentPath: child.agentPath });

      await control.shutdown(child.agentId, "delegate_teardown");
      await control.shutdown(root.agentId, "session_shutdown");

      const result = await control.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(1);
      expect(control.getLive(child.agentId)).toBeUndefined();
      expect(control.getLive(grandchild.agentId)).toBeUndefined();
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumeAgentFromRollout() uses persisted edge metadata for descendants", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "resume-uses-persisted-edge-metadata",
    });
    try {
      const session = stubSession({ rolloutStore });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 3 });
      const root = await control.spawn({ parentPath: "/root" });
      const child = await control.spawn({ parentPath: root.agentPath });
      const grandchild = await control.spawn({ parentPath: child.agentPath });
      const expectedPath = grandchild.agentPath;

      (
        grandchild.metadata as {
          agentPath?: string;
          depth: number;
        }
      ).agentPath = "/root/stale";
      (grandchild.metadata as { depth: number }).depth = 99;

      await control.shutdownAll("manager_shutdown");

      const result = await control.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(3);
      expect(control.getLive(grandchild.agentId)?.agentPath).toBe(expectedPath);
      expect(control.getLive(grandchild.agentId)?.depth).toBe(3);
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumeAgentFromRollout() skips descendants when parent resume fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "resume-skips-corrupt-subtree",
    });
    try {
      const session = stubSession({ rolloutStore });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 3 });
      const root = await control.spawn({ parentPath: "/root" });
      const child = await control.spawn({ parentPath: root.agentPath });
      const grandchild = await control.spawn({ parentPath: child.agentPath });

      const resumeSingle = control.resumeSingleAgentFromRollout.bind(control);
      vi
        .spyOn(control, "resumeSingleAgentFromRollout")
        .mockImplementation(async (opts) => {
          if (opts.metadata.agentId === child.agentId) {
            throw new Error("child metadata corrupted");
          }
          return resumeSingle(opts);
        });

      await control.shutdownAll("manager_shutdown");

      const result = await control.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(1);
      expect(control.getLive(child.agentId)).toBeUndefined();
      expect(control.getLive(grandchild.agentId)).toBeUndefined();
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────
  // Priority-4 fork-mode spawn helpers
  // ───────────────────────────────────────────────────────────

  it("spawnForkedThread() requires a fork parent spawn-call id", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    await expect(
      control.spawnForkedThread("/root", { kind: "full_history" }),
    ).rejects.toThrow(/spawn_agent fork requires a parent spawn call id/);
  });

  it("spawnForkedThread() spawns with fork mode attached (happy path)", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawnForkedThread(
      "/root",
      { kind: "last_n_turns", n: 3 },
      { forkParentSpawnCallId: "call-123" },
    );
    expect(live).toBeDefined();
    expect(live.agentPath.startsWith("/root/")).toBe(true);
    expect(live.depth).toBe(1);
  });

  it("spawnAgentWithMetadata() accepts preset role + threadId", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawnAgentWithMetadata("/root", {
      roleName: "worker",
      threadId: "preset-thread-1",
    });
    expect(live.agentId).toBe("preset-thread-1");
    expect(live.role.name).toBe("worker");
  });

  // ───────────────────────────────────────────────────────────
  // Priority-5 subtree genealogy + render helper
  // ───────────────────────────────────────────────────────────

  it("prepareThreadSpawn() composes metadata without spawning", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const preview = control.prepareThreadSpawn({ parentPath: "/root" });
    expect(preview.metadata.agentPath!.startsWith("/root/")).toBe(true);
    expect(preview.metadata.agentId).toBe("pending");
    // No slot was consumed.
    expect(registry.activeCount).toBe(0);
  });

  it("openThreadSpawnChildren() returns direct children in path order", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const a = await control.spawn({ parentPath: parent.agentPath });
    const b = await control.spawn({ parentPath: parent.agentPath });
    const children = control.openThreadSpawnChildren(parent.agentId);
    expect(children.map(([, m]) => m.agentPath)).toEqual(
      [a, b]
        .map((x) => x.agentPath)
        .slice()
        .sort((l, r) => l.localeCompare(r)),
    );
  });

  it("liveThreadSpawnDescendants() walks the full tree", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 3 });
    const a = await control.spawn({ parentPath: "/root" });
    const b = await control.spawn({ parentPath: a.agentPath });
    const c = await control.spawn({ parentPath: b.agentPath });
    const descendants = control.liveThreadSpawnDescendants(a.agentId);
    expect(descendants).toContain(b.agentId);
    expect(descendants).toContain(c.agentId);
    expect(descendants.length).toBe(2);
  });

  it("renderInputPreview() keeps first line + truncates", () => {
    expect(renderInputPreview("one line")).toBe("one line");
    expect(renderInputPreview("first line\nsecond")).toBe("first line");
    const big = "x".repeat(300);
    const out = renderInputPreview(big);
    expect(out.length).toBe(200);
    expect(out.endsWith("...")).toBe(true);
  });
});
