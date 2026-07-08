import { describe, expect, it, vi } from "vitest";

import type { AgentStatus } from "../agents/status.js";
import type { RunAgentResult } from "../agents/run-agent.js";
import type { CacheSafeParams } from "../services/PromptSuggestion/runtime.js";
import {
  BackgroundTaskError,
  BackgroundTaskLifecycle,
  registerAgentThreadTask,
  type AgentThreadTaskHandle,
} from "./index.js";

class FakeStatus {
  value: AgentStatus = { status: "pending_init" };
  private readonly listeners = new Set<(status: AgentStatus) => void>();

  subscribe(listener: (status: AgentStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(status: AgentStatus): void {
    this.value = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Several macrotask turns, not one: bindPromise's onFulfilled mapper is
// async (it dynamically imports the hook dispatcher for SubagentStop),
// so a single setTimeout(0) can lose the race under full-suite load.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

function cacheSafeParams(): CacheSafeParams {
  return {
    systemPrompt: "system",
    userContext: {},
    systemContext: {},
    toolUseContext: {
      options: { tools: [{ name: "Read" }] },
      getAppState: () => ({
        promptSuggestionEnabled: false,
        pendingWorkerRequest: null,
        pendingSandboxRequest: null,
        elicitation: { queue: [] },
        toolPermissionContext: { mode: "default" },
        promptSuggestion: {
          text: null,
          promptId: null,
          shownAt: 0,
          acceptedAt: 0,
          generationRequestId: null,
        },
        speculation: { status: "idle" },
        speculationSessionTimeSavedMs: 0,
      }),
    },
    forkContextMessages: [],
  } as CacheSafeParams;
}

describe("BackgroundTaskLifecycle", () => {
  it("tracks output deltas and terminal completion notifications", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    const task = lifecycle.register({
      id: "task-1",
      type: "generic",
      description: "collect data",
      aliases: ["/root/task-output"],
    });

    expect(task.status).toBe("running");
    lifecycle.appendOutput(task.id, "alpha");
    lifecycle.appendOutput(task.id, "\nbeta");

    expect(lifecycle.readOutput("/root/task-output")).toBe("alpha\nbeta");
    expect(lifecycle.takeOutputDelta("/root/task-output")).toEqual({
      content: "alpha\nbeta",
      newOffset: 10,
    });
    expect(lifecycle.takeOutputDelta(task.id)).toEqual({
      content: "",
      newOffset: 10,
    });

    lifecycle.bindPromise(task.id, Promise.resolve("done"), {
      onFulfilled: (value) => ({ output: `\n${value}` }),
    });
    await flush();

    const completed = lifecycle.get(task.id);
    expect(completed?.status).toBe("completed");
    expect(lifecycle.readOutput("/root/task-output")).toBe("alpha\nbeta\ndone");

    const notifications = lifecycle.drainNotifications();
    expect(notifications.map((n) => n.kind)).toEqual([
      "started",
      "progress",
      "progress",
      "progress",
      "completed",
    ]);
    expect(lifecycle.get(task.id)?.notified).toBe(true);
    expect(lifecycle.evictNotifiedTerminalTasks()).toEqual([task.id]);
  });

  it("stops running tasks through their backing abort path", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    const abortController = new AbortController();
    let stoppedWith: string | undefined;
    lifecycle.register({
      id: "task-2",
      type: "local_bash",
      description: "watch logs",
      abortController,
      onStop: (reason) => {
        stoppedWith = reason;
      },
    });

    const stopped = await lifecycle.stop("task-2", "user requested stop");

    expect(stopped.status).toBe("killed");
    expect(abortController.signal.aborted).toBe(true);
    expect(stoppedWith).toBe("user requested stop");
    await expect(lifecycle.stop("task-2")).rejects.toMatchObject({
      code: "not_running",
    } satisfies Partial<BackgroundTaskError>);
  });

  it("reaches a terminal state and surfaces the error when onStop throws", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    lifecycle.register({
      id: "task-zombie",
      type: "local_bash",
      description: "stubborn task",
      onStop: () => {
        throw new Error("teardown blew up");
      },
    });

    await expect(lifecycle.stop("task-zombie", "user stop")).rejects.toMatchObject(
      {
        code: "stop_failed",
      } satisfies Partial<BackgroundTaskError>,
    );

    // The task must not be left as a zombie stuck in `running`.
    const snapshot = lifecycle.get("task-zombie");
    expect(snapshot?.status).toBe("killed");
    expect(snapshot?.error).toContain("teardown blew up");

    // A second stop should now report the task is no longer running.
    await expect(lifecycle.stop("task-zombie")).rejects.toMatchObject({
      code: "not_running",
    } satisfies Partial<BackgroundTaskError>);
  });

  it("bounds the notification buffer so it cannot grow unbounded", () => {
    const lifecycle = new BackgroundTaskLifecycle();
    const id = "noisy";
    lifecycle.register({
      id,
      type: "generic",
      description: "chatty task",
    });

    // Far exceed the retention cap (1_000) with progress notifications.
    for (let index = 0; index < 5_000; index += 1) {
      lifecycle.appendOutput(id, `chunk-${index}`);
    }

    const drained = lifecycle.drainNotifications();
    expect(drained.length).toBeLessThanOrEqual(1_000);
    // The oldest "started" notification must have been evicted.
    expect(drained.some((item) => item.kind === "started")).toBe(false);
    // Most recent notifications are retained.
    expect(drained.at(-1)?.delta).toBe("chunk-4999");
    // Draining empties the buffer for the next consumer.
    expect(lifecycle.drainNotifications()).toHaveLength(0);
  });

  it("does not let late promise completion overwrite a stopped task", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    const done = deferred<string>();
    lifecycle.register({
      id: "task-3",
      type: "generic",
      description: "slow task",
    });
    lifecycle.bindPromise("task-3", done.promise);

    await lifecycle.stop("task-3");
    done.resolve("too late");
    await flush();

    expect(lifecycle.get("task-3")?.status).toBe("killed");
  });

  it("caps output buffers and evicts old terminal tasks", () => {
    const lifecycle = new BackgroundTaskLifecycle();
    const retainedIds: string[] = [];

    for (let index = 0; index < 105; index += 1) {
      const id = `task-${index}`;
      retainedIds.push(id);
      lifecycle.register({
        id,
        type: "generic",
        description: `task ${index}`,
      });
      lifecycle.complete(id, "done");
    }

    expect(lifecycle.get(retainedIds[0]!)).toBeUndefined();
    expect(lifecycle.get(retainedIds[4]!)).toBeUndefined();
    expect(lifecycle.get(retainedIds[5]!)).toBeDefined();

    const large = lifecycle.register({
      id: "large",
      type: "generic",
      description: "large output",
    });
    lifecycle.appendOutput(large.id, "a".repeat(1_000_050));
    expect(lifecycle.readOutput(large.id).length).toBe(1_000_000);
  });

  it("stores agent progress summaries without clobbering live counts", () => {
    const lifecycle = new BackgroundTaskLifecycle();
    lifecycle.register({
      id: "agent-progress",
      type: "local_agent",
      description: "inspect",
    });

    lifecycle.updateAgentProgress("agent-progress", {
      toolUseCount: 2,
      tokenCount: 100,
    });
    lifecycle.updateAgentSummary("agent-progress", "Reading files");
    lifecycle.updateAgentProgress("agent-progress", {
      toolUseCount: 3,
      tokenCount: 150,
    });

    expect(lifecycle.get("agent-progress")?.progress).toEqual({
      toolUseCount: 3,
      tokenCount: 150,
      summary: "Reading files",
    });
    expect(lifecycle.drainNotifications().map((item) => item.kind)).toContain(
      "progress",
    );
  });
});

describe("registerAgentThreadTask", () => {
  it("maps AgentThread status, join result, and stop to lifecycle state", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    const status = new FakeStatus();
    const joined = deferred<RunAgentResult>();
    const abortController = new AbortController();
    const thread: AgentThreadTaskHandle = {
      threadId: "agent-1",
      threadName: "explorer-1",
      agentPath: "/root/explorer-1",
      taskPrompt: "inspect runtime tasks",
      live: {
        abortController,
        status,
      },
      join: () => joined.promise,
    };

    registerAgentThreadTask(lifecycle, thread);
    status.set({ status: "running", turnId: "turn-1", startedAtMs: 10 });

    expect(lifecycle.get("agent-1")?.status).toBe("running");
    expect(lifecycle.get("/root/explorer-1")?.id).toBe("agent-1");
    expect(lifecycle.get("agent-1")?.metadata).toMatchObject({
      threadName: "explorer-1",
      agentPath: "/root/explorer-1",
      turnId: "turn-1",
    });

    await lifecycle.stop("/root/explorer-1", "TaskStop");
    expect(abortController.signal.aborted).toBe(true);

    joined.resolve({
      threadId: "agent-1",
      durationMs: 25,
      outcome: "completed",
      finalMessage: "finished after stop",
    });
    await flush();

    expect(lifecycle.get("agent-1")?.status).toBe("killed");
  });

  it("marks AgentThread completion as completed with final output", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    const status = new FakeStatus();
    const joined = deferred<RunAgentResult>();
    const thread: AgentThreadTaskHandle = {
      threadId: "agent-2",
      taskPrompt: "summarize",
      live: {
        abortController: new AbortController(),
        status,
      },
      join: () => joined.promise,
    };

    registerAgentThreadTask(lifecycle, thread);
    status.set({
      status: "completed",
      turnId: "turn-2",
      endedAtMs: 20,
      lastMessage: "summary",
    });
    joined.resolve({
      threadId: "agent-2",
      durationMs: 10,
      outcome: "completed",
      finalMessage: "summary",
    });
    await flush();

    expect(lifecycle.get("agent-2")?.status).toBe("completed");
    expect(lifecycle.readOutput("agent-2")).toBe("summary");
    expect(lifecycle.get("agent-2")?.metadata).toMatchObject({
      finalMessage: "summary",
    });
  });

  it("plumbs live tokenUsage and tool-use counts into the emitted snapshot progress", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    const status = new FakeStatus();
    const joined = deferred<RunAgentResult>();
    // A live handle whose accumulated counters look like a substantial run:
    // 51000 cumulative tokens and 3 tool calls across the transcript.
    const live = {
      agentId: "agent-counts",
      abortController: new AbortController(),
      status,
      tokenUsage: { totalTokens: 51000 },
      messages: [
        { role: "user", content: "build it" },
        {
          role: "assistant",
          content: "running tools",
          toolCalls: [
            { id: "c1", name: "Bash", arguments: "{}" },
            { id: "c2", name: "Edit", arguments: "{}" },
          ],
        },
        { role: "tool", toolCallId: "c1", toolName: "Bash", content: "ok" },
        {
          role: "assistant",
          content: "one more",
          toolCalls: [{ id: "c3", name: "Read", arguments: "{}" }],
        },
      ],
    };
    const snapshots: Array<{
      readonly status: string;
      readonly toolUseCount?: number;
      readonly tokenCount?: number;
    }> = [];
    const thread: AgentThreadTaskHandle = {
      threadId: "agent-counts",
      taskPrompt: "build a CLI",
      live: live as unknown as AgentThreadTaskHandle["live"],
      join: () => joined.promise,
    };

    registerAgentThreadTask(lifecycle, thread, {
      // Disable the poller; drive snapshots through status transitions so the
      // assertions are deterministic.
      progressIntervalMs: 0,
      onSnapshot: (snapshot) => {
        snapshots.push({
          status: snapshot.status,
          toolUseCount: snapshot.progress?.toolUseCount,
          tokenCount: snapshot.progress?.tokenCount,
        });
      },
    });

    status.set({ status: "running", turnId: "turn-1", startedAtMs: 10 });

    // The running snapshot must carry the REAL live counts, not 0.
    const running = lifecycle.get("agent-counts");
    expect(running?.status).toBe("running");
    expect(running?.progress?.toolUseCount).toBe(3);
    expect(running?.progress?.tokenCount).toBe(51000);

    // The registration snapshot fires before the first progress refresh, so
    // assert on the LATEST running snapshot the subscriber observed.
    const runningSnapshots = snapshots.filter((s) => s.status === "running");
    const latestRunning = runningSnapshots.at(-1);
    expect(latestRunning?.toolUseCount).toBe(3);
    expect(latestRunning?.tokenCount).toBe(51000);

    joined.resolve({
      threadId: "agent-counts",
      durationMs: 10,
      outcome: "completed",
      finalMessage: "done",
    });
    await flush();

    // The terminal snapshot must preserve the final counts, never reset to 0.
    const completed = lifecycle.get("agent-counts");
    expect(completed?.status).toBe("completed");
    expect(completed?.progress?.toolUseCount).toBe(3);
    expect(completed?.progress?.tokenCount).toBe(51000);
  });

  it("starts AgentSummary for registered threads and writes progress summaries", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new BackgroundTaskLifecycle();
      const status = new FakeStatus();
      const joined = deferred<RunAgentResult>();
      let cacheSafeParamsListener:
        | ((params: CacheSafeParams) => void)
        | null = null;
      const runForkedAgent = vi.fn(async () => ({
        messages: [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "Reading files" }] },
          },
        ],
        totalUsage: {},
      }));
      const thread: AgentThreadTaskHandle = {
        threadId: "agent-3",
        taskPrompt: "inspect summary",
        messages: [
          { role: "user", content: "one" },
          {
            role: "assistant",
            content: "using a tool",
            toolCalls: [
              { id: "call-1", name: "Read", arguments: '{"file_path":"x.ts"}' },
            ],
          },
          {
            role: "tool",
            toolCallId: "call-1",
            toolName: "Read",
            content: "file body",
          },
        ],
        live: {
          agentId: "agent-3",
          abortController: new AbortController(),
          status,
        },
        onSummaryCacheSafeParams: (listener) => {
          cacheSafeParamsListener = listener;
          return () => {
            cacheSafeParamsListener = null;
          };
        },
        join: () => joined.promise,
      };

      registerAgentThreadTask(lifecycle, thread, {
        summary: {
          intervalMs: 10,
          runForkedAgent: runForkedAgent as never,
        },
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(runForkedAgent).not.toHaveBeenCalled();
      expect(cacheSafeParamsListener).not.toBeNull();
      cacheSafeParamsListener?.(cacheSafeParams());
      await vi.advanceTimersByTimeAsync(10);

      expect(runForkedAgent).toHaveBeenCalledTimes(1);
      expect(lifecycle.get("agent-3")?.progress?.summary).toBe("Reading files");
      expect(
        runForkedAgent.mock.calls[0]?.[0].cacheSafeParams.forkContextMessages,
      ).toHaveLength(3);
      const forkMessages =
        runForkedAgent.mock.calls[0]?.[0].cacheSafeParams.forkContextMessages;
      expect(forkMessages?.[1]?.message.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_use",
            id: "call-1",
            input: { file_path: "x.ts" },
          }),
        ]),
      );
      expect(forkMessages?.[2]?.message.content).toEqual([
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "call-1",
          content: [
            expect.objectContaining({ type: "text", text: "file body" }),
          ],
        }),
      ]);

      await lifecycle.stop("agent-3", "done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start AgentSummary for already-terminal threads", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new BackgroundTaskLifecycle();
      const status = new FakeStatus();
      status.set({
        status: "completed",
        turnId: "turn-terminal",
        endedAtMs: 30,
        lastMessage: "done",
      });
      const joined = deferred<RunAgentResult>();
      const runForkedAgent = vi.fn(async () => ({
        messages: [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "Should not run" }] },
          },
        ],
        totalUsage: {},
      }));
      const thread: AgentThreadTaskHandle = {
        threadId: "agent-terminal",
        taskPrompt: "already done",
        live: {
          agentId: "agent-terminal",
          abortController: new AbortController(),
          status,
        },
        summaryCacheSafeParams: cacheSafeParams(),
        join: () => joined.promise,
      };

      registerAgentThreadTask(lifecycle, thread, {
        summary: {
          intervalMs: 10,
          runForkedAgent: runForkedAgent as never,
        },
      });
      await vi.advanceTimersByTimeAsync(50);

      expect(runForkedAgent).not.toHaveBeenCalled();
      expect(lifecycle.get("agent-terminal")?.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });
});
