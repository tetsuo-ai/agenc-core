import { describe, expect, it, vi } from "vitest";
import { AgentThread } from "./thread.js";
import type { LiveAgent } from "./control.js";
import { AgentStatusTracker } from "./status.js";
import { resolveAgentRole } from "./role.js";
import { Mailbox } from "./mailbox.js";
import type { LLMMessage } from "../llm/types.js";

function makeLive(): LiveAgent {
  return {
    agentId: "thread-1",
    agentPath: "/root/alpha",
    role: resolveAgentRole(undefined),
    depth: 1,
    nickname: "alpha",
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: "thread-1" }),
    downInbox: new Mailbox({ threadId: "thread-1-down" }),
    abortController: new AbortController(),
  };
}

describe("AgentThread", () => {
  it("exposes threadId/path/nickname from the live agent", () => {
    const t = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      forkMode: { kind: "new" },
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
      forkMode: { kind: "new" },
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
      forkMode: { kind: "new" },
      taskPrompt: "hi",
    });
    const seen: string[] = [];
    const unsub = t.onStatusChange((s) => seen.push(s.status));
    live.status.markRunning("turn-1");
    unsub();
    expect(seen).toContain("running");
  });
});

// ─────────────────────────────────────────────────────────────────────
// T9-A5 literal method surface: threadName, messages, memory,
// worktreePath, fork(), spawn(), join()
// ─────────────────────────────────────────────────────────────────────
describe("AgentThread — openclaude-parity getters", () => {
  it("threadName falls back to agentId when nickname is empty", () => {
    const live = makeLive();
    (live as { nickname: string }).nickname = "";
    const t = new AgentThread({
      live,
      initialMessages: [],
      forkMode: { kind: "new" },
      taskPrompt: "hi",
    });
    expect(t.threadName).toBe(live.agentId);
  });

  it("threadName aliases nickname when present", () => {
    const live = makeLive();
    const t = new AgentThread({
      live,
      initialMessages: [],
      forkMode: { kind: "new" },
      taskPrompt: "hi",
    });
    expect(t.threadName).toBe("alpha");
  });

  it("messages mirrors initialMessages", () => {
    const msgs: LLMMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const t = new AgentThread({
      live: makeLive(),
      initialMessages: msgs,
      forkMode: { kind: "new" },
      taskPrompt: "hi",
    });
    expect(t.messages).toEqual(msgs);
  });

  it("memory returns [] until T10 wires the real store", () => {
    const t = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      forkMode: { kind: "new" },
      taskPrompt: "hi",
    });
    expect(t.memory).toEqual([]);
  });

  it("worktreePath aliases worktree.path", () => {
    const t1 = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      forkMode: { kind: "new" },
      taskPrompt: "hi",
    });
    expect(t1.worktreePath).toBeUndefined();

    const t2 = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      forkMode: { kind: "new" },
      taskPrompt: "hi",
      worktree: {
        path: "/tmp/wt",
        branch: "feature-x",
        gitRoot: "/repo",
        created: true,
      } as never,
    });
    expect(t2.worktreePath).toBe("/tmp/wt");
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
        forkMode: { kind: "new" },
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

  it("spawn() dispatches with forkMode = new by default", async () => {
    const childLive = makeLive();
    const childThread = new AgentThread({
      live: childLive,
      initialMessages: [],
      forkMode: { kind: "new" },
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
        forkMode: { kind: "new" },
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
    expect(delegateFn.mock.calls[0]![0]!.forkMode).toEqual({ kind: "new" });
  });

  it("fork() without wiring throws a clear error", async () => {
    const parent = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      forkMode: { kind: "new" },
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
        forkMode: { kind: "new" },
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
      forkMode: { kind: "new" },
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
      forkMode: { kind: "new" },
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
});
