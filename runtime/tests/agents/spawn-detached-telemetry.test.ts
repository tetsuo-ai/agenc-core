/**
 * A spawn whose lifecycle registration collides with the daemon's own
 * pre-registration must still emit its status/counter telemetry: the
 * onSnapshot hook died with the duplicate registration, and attached UIs
 * saw agents spawn and finish with no status and `tools 0 tokens 0`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachDetachedSpawnTelemetry } from "../../src/agents/v2/spawn.js";
import type { AgentThreadTaskHandle } from "../../src/tasks/index.js";
import type { BackgroundTaskSnapshot } from "../../src/tasks/index.js";

type StatusListener = (status: { status: string }) => void;

function fakeThread(): {
  thread: AgentThreadTaskHandle;
  setStatus: (status: string) => void;
  counters: { tokens: number; tools: number };
} {
  const counters = { tokens: 0, tools: 0 };
  const listeners: StatusListener[] = [];
  let value = { status: "running" };
  const thread = {
    threadId: "t-1",
    live: {
      agentId: "a-1",
      agentPath: "/root/worker",
      status: {
        get value() {
          return value;
        },
        subscribe: (listener: StatusListener) => {
          listeners.push(listener);
          return () => {};
        },
      },
      get tokenUsage() {
        return { totalTokens: counters.tokens };
      },
      get toolCallCount() {
        return counters.tools;
      },
    },
  } as unknown as AgentThreadTaskHandle;
  return {
    thread,
    counters,
    setStatus: (status: string) => {
      value = { status };
      for (const listener of listeners) listener(value);
    },
  };
}

describe("attachDetachedSpawnTelemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits an immediate running status with live counters", () => {
    const { thread, counters } = fakeThread();
    counters.tools = 2;
    counters.tokens = 1200;
    const emitted: BackgroundTaskSnapshot[] = [];
    attachDetachedSpawnTelemetry(thread, (snapshot) => emitted.push(snapshot));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.status).toBe("running");
    expect(emitted[0]?.progress).toEqual({ toolUseCount: 2, tokenCount: 1200 });
  });

  it("polls counters and emits only when they advance", () => {
    const { thread, counters } = fakeThread();
    const emitted: BackgroundTaskSnapshot[] = [];
    attachDetachedSpawnTelemetry(thread, (snapshot) => emitted.push(snapshot));
    emitted.length = 0;
    vi.advanceTimersByTime(3_000);
    expect(emitted).toHaveLength(1);
    counters.tools = 3;
    counters.tokens = 9000;
    vi.advanceTimersByTime(1_000);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.progress).toEqual({ toolUseCount: 3, tokenCount: 9000 });
    vi.advanceTimersByTime(5_000);
    expect(emitted).toHaveLength(2);
  });

  it("maps raw agent words onto the closed wire vocabulary", () => {
    const { thread, setStatus } = fakeThread();
    const emitted: BackgroundTaskSnapshot[] = [];
    attachDetachedSpawnTelemetry(thread, (snapshot) => emitted.push(snapshot));
    setStatus("errored");
    expect(emitted.at(-1)?.status).toBe("failed");
    const again = fakeThread();
    const emitted2: BackgroundTaskSnapshot[] = [];
    attachDetachedSpawnTelemetry(again.thread, (s2) => emitted2.push(s2));
    again.setStatus("shutdown");
    expect(emitted2.at(-1)?.status).toBe("killed");
  });

  it("emits the terminal status and stops polling after it", () => {
    const { thread, counters, setStatus } = fakeThread();
    const emitted: BackgroundTaskSnapshot[] = [];
    attachDetachedSpawnTelemetry(thread, (snapshot) => emitted.push(snapshot));
    emitted.length = 0;
    counters.tools = 5;
    counters.tokens = 40_000;
    setStatus("completed");
    expect(emitted.at(-1)?.status).toBe("completed");
    const settled = emitted.length;
    counters.tools = 9;
    vi.advanceTimersByTime(10_000);
    expect(emitted).toHaveLength(settled);
  });
});
