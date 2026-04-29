import { describe, expect, it } from "vitest";

import type { AgentStatus } from "../agents/status.js";
import type { RunAgentResult } from "../agents/run-agent.js";
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

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe("BackgroundTaskLifecycle", () => {
  it("tracks output deltas and terminal completion notifications", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    const task = lifecycle.register({
      id: "task-1",
      type: "generic",
      description: "collect data",
    });

    expect(task.status).toBe("running");
    lifecycle.appendOutput(task.id, "alpha");
    lifecycle.appendOutput(task.id, "\nbeta");

    expect(lifecycle.takeOutputDelta(task.id)).toEqual({
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
    expect(lifecycle.readOutput(task.id)).toBe("alpha\nbeta\ndone");

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
    expect(lifecycle.get("agent-1")?.metadata).toMatchObject({
      threadName: "explorer-1",
      agentPath: "/root/explorer-1",
      turnId: "turn-1",
    });

    await lifecycle.stop("agent-1", "TaskStop");
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
  });
});
