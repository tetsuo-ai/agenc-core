import { describe, expect, it, vi } from "vitest";
import { AgentThread } from "./thread.js";
import type { LiveAgent } from "./control.js";
import { AgentStatusTracker } from "./status.js";
import { createAgentRoleWorkspace, resolveAgentRole } from "./role.js";
import { Mailbox } from "./mailbox.js";
import type { LLMMessage } from "../llm/types.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace(process.cwd());

function makeLive(): LiveAgent {
  return {
    agentId: "thread-1",
    agentPath: "/root/alpha",
    role: resolveAgentRole(ROLE_WORKSPACE, undefined),
    depth: 1,
    nickname: "alpha",
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: "thread-1" }),
    downInbox: new Mailbox({ threadId: "thread-1-down" }),
    abortController: new AbortController(),
    metadata: {
      agentId: "thread-1",
      agentPath: "/root/alpha",
      agentNickname: "alpha",
      agentRole: "default",
      agentRoleWorkspaceId: ROLE_WORKSPACE.id,
      depth: 1,
    },
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

describe("AgentThread", () => {
  it("exposes threadId/path/nickname from the live agent", () => {
    const t = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      taskPrompt: "hi",
    });
    expect(t.threadId).toBe("thread-1");
    expect(t.agentPath).toBe("/root/alpha");
    expect(t.nickname).toBe("alpha");
  });

  it("isInterrupted reflects the abort controller", () => {
    const live = makeLive();
    const t = new AgentThread({
      live,
      initialMessages: [],
      taskPrompt: "hi",
    });
    expect(t.isInterrupted).toBe(false);
    live.abortController.abort("test");
    expect(t.isInterrupted).toBe(true);
  });

  it("onStatusChange subscribes to the status tracker", () => {
    const live = makeLive();
    const t = new AgentThread({
      live,
      initialMessages: [],
      taskPrompt: "hi",
    });
    const seen: string[] = [];
    const unsub = t.onStatusChange((s) => seen.push(s.status));
    live.status.markRunning("turn-1");
    unsub();
    expect(seen).toContain("running");
  });

  it("rebindLive updates the exposed live handle and rebroadcasts status", () => {
    const live1 = makeLive();
    const thread = new AgentThread({
      live: live1,
      initialMessages: [],
      taskPrompt: "hi",
    });

    const seen: string[] = [];
    const unsubscribe = thread.onStatusChange((status) => {
      seen.push(status.status);
    });

    const live2 = makeLive();
    (live2 as { agentId: string }).agentId = "thread-2";
    (live2 as { agentPath: string }).agentPath = "/root/beta";
    (live2 as { nickname: string }).nickname = "beta";

    thread.rebindLive(live2);
    live2.status.markRunning("turn-2");
    unsubscribe();

    expect(thread.threadId).toBe("thread-2");
    expect(thread.agentPath).toBe("/root/beta");
    expect(thread.nickname).toBe("beta");
    expect(seen).toContain("pending_init");
    expect(seen).toContain("running");
  });

  it("rebindLive updates the default child-parent path when the thread owned it", async () => {
    const delegateFn = vi.fn(async () => ({
      kind: "async_launched" as const,
      thread: new AgentThread({
        live: makeLive(),
        initialMessages: [],
          taskPrompt: "child",
      }),
    }));

    const thread = new AgentThread(
      {
        live: makeLive(),
        initialMessages: [],
          taskPrompt: "parent",
      },
      {
        delegate: delegateFn as unknown as Parameters<typeof AgentThread>[1]["delegate"],
        parent: {} as never,
        control: {} as never,
        registry: {} as never,
        parentPath: "/root/alpha",
      },
    );

    const rebound = makeLive();
    (rebound as { agentPath: string }).agentPath = "/root/beta";
    thread.rebindLive(rebound);
    await thread.spawn({ taskPrompt: "go" });

    expect(delegateFn.mock.calls[0]![0]!.parentPath).toBe("/root/beta");
  });
});

// ─────────────────────────────────────────────────────────────────────
// T9-A5 literal method surface: threadName, messages, memory,
// worktreePath, fork(), spawn(), join()
// ─────────────────────────────────────────────────────────────────────
describe("AgentThread — AgenC-compatible getters", () => {
  it("threadName falls back to agentId when nickname is empty", () => {
    const live = makeLive();
    (live as { nickname: string }).nickname = "";
    const t = new AgentThread({
      live,
      initialMessages: [],
      taskPrompt: "hi",
    });
    expect(t.threadName).toBe(live.agentId);
  });

  it("threadName aliases nickname when present", () => {
    const live = makeLive();
    const t = new AgentThread({
      live,
      initialMessages: [],
      taskPrompt: "hi",
    });
    expect(t.threadName).toBe("alpha");
  });

  it("messages mirrors initialMessages until live transcript exists", () => {
    const msgs: LLMMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const t = new AgentThread({
      live: makeLive(),
      initialMessages: msgs,
      taskPrompt: "hi",
    });
    expect(t.messages).toEqual(msgs);
  });

  it("messages returns the live transcript once populated", () => {
    const live = makeLive();
    live.messages.push({ role: "assistant", content: "live reply" });
    const t = new AgentThread({
      live,
      initialMessages: [{ role: "user", content: "seed" }],
      taskPrompt: "hi",
    });
    expect(t.messages).toEqual([{ role: "assistant", content: "live reply" }]);
  });

  it("metadata mirrors the current live handle", () => {
    const t = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      taskPrompt: "hi",
    });
    expect(t.metadata.agentPath).toBe("/root/alpha");
    expect(t.metadata.agentNickname).toBe("alpha");
  });

  it("memory returns live memory entries", () => {
    const live = makeLive();
    live.memoryEntries.push({ key: "k", value: "v", at: 1 });
    const t = new AgentThread({
      live,
      initialMessages: [],
      taskPrompt: "hi",
    });
    expect(t.memory).toEqual([{ key: "k", value: "v", at: 1 }]);
  });

  it("worktreePath aliases worktree.path", () => {
    const t1 = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      taskPrompt: "hi",
    });
    expect(t1.worktreePath).toBeUndefined();

    const t2 = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      taskPrompt: "hi",
      worktree: {
        path: "/tmp/wt",
        branch: "feature-x",
        gitRoot: "/repo",
        created: true,
      } as never,
    });
    expect(t2.worktreePath).toBe("/tmp/wt");
    expect(t2.worktreeBranch).toBe("feature-x");
  });
});

describe("AgentThread — fork/spawn/join", () => {
  it("fork() dispatches with forkMode = full_history by default", async () => {
    const childLive = makeLive();
    (childLive as { agentId: string }).agentId = "child-1";
    const childThread = new AgentThread({
      live: childLive,
      initialMessages: [],
      forkMode: { kind: "full_history" },
      taskPrompt: "child-task",
    });
    const delegateFn = vi.fn(async () => ({
      kind: "sync_completed" as const,
      thread: childThread,
      result: {
        threadId: "child-1",
        durationMs: 10,
        outcome: "completed" as const,
      },
    }));

    const parentLive = makeLive();
    const parent = new AgentThread(
      {
        live: parentLive,
        initialMessages: [],
          taskPrompt: "parent",
      },
      {
        delegate: delegateFn as unknown as Parameters<typeof AgentThread>[1]["delegate"],
        parent: {} as never,
        control: {} as never,
        registry: {} as never,
        parentPath: "/root",
      },
    );

    const child = await parent.fork({ taskPrompt: "do the thing" });
    expect(child).toBe(childThread);
    expect(delegateFn).toHaveBeenCalledOnce();
    expect(delegateFn.mock.calls[0]![0]!.forkMode).toEqual({
      kind: "full_history",
    });
    expect(delegateFn.mock.calls[0]![0]!.taskPrompt).toBe("do the thing");
  });

  it("spawn() dispatches with forkMode undefined by default", async () => {
    const childLive = makeLive();
    const childThread = new AgentThread({
      live: childLive,
      initialMessages: [],
      taskPrompt: "child-task",
    });
    const delegateFn = vi.fn(async () => ({
      kind: "async_launched" as const,
      thread: childThread,
    }));

    const parent = new AgentThread(
      {
        live: makeLive(),
        initialMessages: [],
          taskPrompt: "parent",
      },
      {
        delegate: delegateFn as unknown as Parameters<typeof AgentThread>[1]["delegate"],
        parent: {} as never,
        control: {} as never,
        registry: {} as never,
      },
    );

    const child = await parent.spawn({ taskPrompt: "go" });
    expect(child).toBe(childThread);
    expect(delegateFn.mock.calls[0]![0]!.forkMode).toBeUndefined();
  });

  it("fork() without wiring throws a clear error", async () => {
    const parent = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      taskPrompt: "parent",
    });
    await expect(parent.fork({ taskPrompt: "x" })).rejects.toThrow(
      /wiring/,
    );
  });

  it("join() returns initialResult when dispatcher ran in sync mode", async () => {
    const parent = new AgentThread(
      {
        live: makeLive(),
        initialMessages: [],
          taskPrompt: "parent",
      },
      {
        initialResult: {
          threadId: "thread-1",
          durationMs: 7,
          outcome: "completed",
          finalMessage: "done",
        },
      },
    );
    const result = await parent.join();
    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("done");
  });

  it("join() resolves when status reaches completed", async () => {
    const live = makeLive();
    const parent = new AgentThread({
      live,
      initialMessages: [],
      taskPrompt: "parent",
    });
    // Transition asynchronously.
    queueMicrotask(() => {
      live.status.markRunning("turn-1");
      live.status.markCompleted("turn-1", "all done");
    });
    const result = await parent.join();
    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("all done");
  });

  it("join() maps errored status to outcome='errored'", async () => {
    const live = makeLive();
    const parent = new AgentThread({
      live,
      initialMessages: [],
      taskPrompt: "parent",
    });
    queueMicrotask(() => {
      live.status.markRunning("turn-1");
      live.status.markErrored("turn-1", "kaboom");
    });
    const result = await parent.join();
    expect(result.outcome).toBe("errored");
    expect(result.error).toBe("kaboom");
  });

  it("join() follows a rebound live handle", async () => {
    const live1 = makeLive();
    const thread = new AgentThread({
      live: live1,
      initialMessages: [],
      taskPrompt: "parent",
    });

    const live2 = makeLive();
    (live2 as { agentId: string }).agentId = "thread-2";
    queueMicrotask(() => {
      thread.rebindLive(live2);
      live2.status.markRunning("turn-2");
      live2.status.markCompleted("turn-2", "resumed done");
    });

    const result = await thread.join();
    expect(result.threadId).toBe("thread-2");
    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("resumed done");
  });
});
