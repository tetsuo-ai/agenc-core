import { describe, expect, it, vi } from "vitest";

vi.mock("./fork-context.js", () => ({
  forkSubagent: vi.fn(async () => ({
    messages: [{ role: "user", content: "seed prompt" }],
  })),
}));

vi.mock("./run-agent.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../session/event-log.js", () => ({
  emitWarning: vi.fn(),
}));

import { AgentStatusTracker } from "./status.js";
import { Mailbox } from "./mailbox.js";
import { resolveAgentRole } from "./role.js";
import { delegate } from "./delegate.js";
import { forkSubagent } from "./fork-context.js";
import { runAgent } from "./run-agent.js";
import type { LiveAgent } from "./control.js";
import type { AgentMetadata } from "./registry.js";

const mockRunAgent = vi.mocked(runAgent);
const mockForkSubagent = vi.mocked(forkSubagent);

function makeLive(
  agentId: string,
  agentPath: string,
  nickname = "alpha",
): LiveAgent {
  const metadata: AgentMetadata = {
    agentId,
    agentPath,
    agentNickname: nickname,
    agentRole: "default",
    depth: 1,
  };
  return {
    agentId,
    agentPath,
    role: resolveAgentRole(undefined),
    depth: 1,
    nickname,
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: agentId }),
    downInbox: new Mailbox({ threadId: `${agentId}-down` }),
    abortController: new AbortController(),
    metadata,
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function makeParentSession() {
  return {
    conversationId: "parent-session",
    abortController: new AbortController(),
    eventLog: {},
    nextInternalSubId: () => "sub-1",
    snapshotHistoryMessages: () => [],
    sessionConfiguration: { cwd: "/repo" },
    config: { cwd: "/repo" },
  };
}

function runResult(result: {
  threadId: string;
  durationMs: number;
  outcome: "completed" | "errored" | "interrupted" | "aborted";
  finalMessage?: string;
  error?: unknown;
}) {
  return (async function* () {
    return result;
  })();
}

describe("delegate lifecycle recovery", () => {
  it("launches in the background by default", async () => {
    const live = makeLive("thread-bg", "/root/background");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-bg",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "run separately",
    });

    expect(outcome.kind).toBe("async_launched");
    if (outcome.kind !== "async_launched") {
      throw new Error("expected async_launched");
    }
    await outcome.thread.join();
    expect(control.shutdown).not.toHaveBeenCalled();
  });

  it("forceSynchronous overrides role-level background mode", async () => {
    const live = {
      ...makeLive("thread-sync", "/root/sync"),
      role: {
        ...resolveAgentRole(undefined),
        config: { background: true },
      },
    };
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-sync",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "run inline",
      runInBackground: false,
      forceSynchronous: true,
    });

    expect(outcome.kind).toBe("sync_completed");
    expect(control.shutdown).toHaveBeenCalledWith(
      "thread-sync",
      "delegate_teardown",
    );
  });

  it("passes normalized parent history into forkSubagent for inherited fork modes", async () => {
    const live = makeLive("thread-1", "/root/alpha");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    const history = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    await delegate({
      parent: {
        ...makeParentSession(),
        snapshotHistoryMessages: () => history,
      } as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "inspect history",
      forkMode: { kind: "full_history" },
    });

    expect(mockForkSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessages: history,
        mode: { kind: "full_history" },
      }),
    );
  });

  it("passes parent history into last_n_turns forks", async () => {
    const live = makeLive("thread-2", "/root/bravo");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    const history = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-2",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    await delegate({
      parent: {
        ...makeParentSession(),
        snapshotHistoryMessages: () => history,
      } as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "slice history",
      forkMode: { kind: "last_n_turns", n: 2 },
    });

    expect(mockForkSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessages: history,
        mode: { kind: "last_n_turns", n: 2 },
      }),
    );
  });

  it("rejects worktree isolation without a slug", async () => {
    const control = {
      spawn: vi.fn(),
      shutdown: vi.fn(),
      resumeAgentFromRollout: vi.fn(),
    };

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      isolation: "worktree",
    });

    expect(outcome).toEqual({
      kind: "rejected",
      reason: "worktree isolation requires a non-empty worktreeSlug",
    });
    expect(control.spawn).not.toHaveBeenCalled();
  });

  it("resumes the same live agent after a retryable failure", async () => {
    const live1 = makeLive("thread-1", "/root/alpha");
    const resumedLive = makeLive("thread-1", "/root/alpha");
    const control = {
      spawn: vi.fn(async () => live1),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive: resumedLive,
      })),
    };
    const resumeManager = {
      recordFailure: vi.fn(() => ({ kind: "resume" as const, reason: "retry" })),
      recordSuccess: vi.fn(),
    };

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 10,
        outcome: "errored",
        error: new Error("transient"),
      }),
    );
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 12,
        outcome: "completed",
        finalMessage: "done after resume",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      runInBackground: false,
      resumeManager: resumeManager as never,
    });

    expect(outcome.kind).toBe("sync_completed");
    if (outcome.kind !== "sync_completed") {
      throw new Error("expected sync_completed");
    }

    expect(control.spawn).toHaveBeenCalledTimes(1);
    expect(control.shutdown).toHaveBeenCalledWith("thread-1", "delegate_resume");
    expect(control.resumeAgentFromRollout).toHaveBeenCalledWith({
      rootThreadId: "thread-1",
      parentPath: "/root",
      metadata: live1.metadata,
    });
    expect(outcome.thread.threadId).toBe("thread-1");
    expect(outcome.thread.live).toBe(resumedLive);
    expect(outcome.result.finalMessage).toBe("done after resume");
    expect(resumeManager.recordFailure).toHaveBeenCalledOnce();
    expect(resumeManager.recordSuccess).toHaveBeenCalledWith("thread-1");
  });

  it("restarts with a fresh live handle after a hard failure", async () => {
    const live1 = makeLive("thread-1", "/root/alpha");
    const restartedLive = makeLive("thread-2", "/root/bravo");
    const control = {
      spawn: vi
        .fn(async () => live1)
        .mockImplementationOnce(async () => live1)
        .mockImplementationOnce(async () => restartedLive),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 0,
        rootLive: null,
      })),
    };
    const resumeManager = {
      recordFailure: vi.fn(() => ({
        kind: "restart" as const,
        reason: "hard_error",
      })),
      recordSuccess: vi.fn(),
    };

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 10,
        outcome: "errored",
        error: new Error("hard fail"),
      }),
    );
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-2",
        durationMs: 12,
        outcome: "completed",
        finalMessage: "done after restart",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      runInBackground: false,
      resumeManager: resumeManager as never,
    });

    expect(outcome.kind).toBe("sync_completed");
    if (outcome.kind !== "sync_completed") {
      throw new Error("expected sync_completed");
    }

    expect(control.spawn).toHaveBeenCalledTimes(2);
    expect(control.shutdown).toHaveBeenCalledWith("thread-1", "delegate_restart");
    expect(control.shutdown).toHaveBeenCalledWith(
      "thread-2",
      "delegate_teardown",
    );
    expect(control.resumeAgentFromRollout).not.toHaveBeenCalled();
    expect(outcome.thread.threadId).toBe("thread-2");
    expect(outcome.thread.live).toBe(restartedLive);
    expect(outcome.result.threadId).toBe("thread-2");
    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.finalMessage).toBe("done after restart");
    expect(resumeManager.recordSuccess).toHaveBeenCalledWith("thread-2");
  });
});
