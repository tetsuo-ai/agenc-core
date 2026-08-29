import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentStatus } from "../../src/agents/status.js";
import {
  BackgroundTaskLifecycle,
  observeAgentThreadTask,
  registerAgentThreadTask,
  type AgentThreadTaskHandle,
  type BackgroundTaskSnapshot,
} from "../../src/tasks/index.js";

class FakeStatus {
  value: AgentStatus = { status: "pending_init" };
  private readonly listeners = new Set<(status: AgentStatus) => void>();

  subscribe(listener: (status: AgentStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }

  set(status: AgentStatus): void {
    this.value = status;
    for (const listener of this.listeners) listener(status);
  }
}

function registeredThread(): {
  readonly lifecycle: BackgroundTaskLifecycle;
  readonly status: FakeStatus;
  readonly counters: { tokens: number; tools: number };
  readonly thread: AgentThreadTaskHandle;
} {
  const lifecycle = new BackgroundTaskLifecycle();
  const status = new FakeStatus();
  const counters = { tokens: 0, tools: 0 };
  const live = {
    agentId: "agent-1",
    status,
    abortController: new AbortController(),
    get tokenUsage() {
      return { totalTokens: counters.tokens };
    },
    get toolCallCount() {
      return counters.tools;
    },
  };
  const thread: AgentThreadTaskHandle = {
    threadId: "agent-1",
    taskPrompt: "work",
    live,
    join: () => new Promise(() => {}),
  };
  registerAgentThreadTask(lifecycle, thread);
  status.set({ status: "running", turnId: "turn-1", startedAtMs: 1 });
  return { lifecycle, status, counters, thread };
}

describe("detached spawn lifecycle observation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("observes the already-registered canonical task without a second poller", () => {
    const { lifecycle, counters, thread } = registeredThread();
    counters.tools = 2;
    counters.tokens = 1_200;
    vi.advanceTimersByTime(1_000);

    const emitted: BackgroundTaskSnapshot[] = [];
    observeAgentThreadTask(lifecycle, thread, (snapshot) => emitted.push(snapshot));

    expect(emitted.at(-1)).toMatchObject({
      status: "running",
      progress: { toolUseCount: 2, tokenCount: 1_200 },
    });
    emitted.length = 0;
    vi.advanceTimersByTime(3_000);
    expect(emitted).toHaveLength(0);
  });

  it("maps terminal agent states once through the canonical lifecycle", () => {
    const failed = registeredThread();
    const failedSnapshots: BackgroundTaskSnapshot[] = [];
    observeAgentThreadTask(failed.lifecycle, failed.thread, (snapshot) =>
      failedSnapshots.push(snapshot),
    );
    failed.status.set({
      status: "errored",
      turnId: "turn-1",
      endedAtMs: 2,
      error: "boom",
    });
    expect(failedSnapshots.at(-1)).toMatchObject({
      status: "failed",
      error: "boom",
    });

    const killed = registeredThread();
    const killedSnapshots: BackgroundTaskSnapshot[] = [];
    observeAgentThreadTask(killed.lifecycle, killed.thread, (snapshot) =>
      killedSnapshots.push(snapshot),
    );
    killed.status.set({ status: "shutdown" });
    expect(killedSnapshots.at(-1)).toMatchObject({
      status: "killed",
      error: "agent shutdown",
    });
  });

  it("unsubscribes after the terminal snapshot", () => {
    const { lifecycle, status, thread } = registeredThread();
    const emitted: BackgroundTaskSnapshot[] = [];
    observeAgentThreadTask(lifecycle, thread, (snapshot) => emitted.push(snapshot));
    status.set({ status: "shutdown" });
    const settled = emitted.length;

    lifecycle.updateAgentProgress("agent-1", {
      toolUseCount: 99,
      tokenCount: 99,
    });
    expect(emitted).toHaveLength(settled);
  });
});
