import { beforeEach, describe, expect, it } from "vitest";

import {
  clearTrackedSourcesForTest,
  recordPromptState,
  trackedCallCountForTest,
} from "../../../src/services/api/promptCacheBreakDetection.js";

// promptCacheBreakDetection minor (core-todo.md): eviction at MAX_TRACKED_SOURCES
// deleted the oldest-INSERTED key (FIFO), typically repl_main_thread (inserted first,
// never re-inserted while alive). ~10 subagent spawns destroyed the main thread's
// cache-break baseline. Fixed by moving an accessed key to most-recently-used (LRU).

function record(querySource: string, agentId?: string): void {
  recordPromptState({
    system: [],
    toolSchemas: [],
    querySource,
    model: "claude-opus-4-8",
    ...(agentId ? { agentId } : {}),
    fastMode: false,
  } as never);
}

describe("promptCacheBreakDetection — LRU eviction keeps active sources", () => {
  beforeEach(() => clearTrackedSourcesForTest());

  it("does not evict repl_main_thread while it is interleaved with agent spawns", () => {
    // Seed the main-thread baseline (querySource 'compact' -> 'repl_main_thread').
    record("compact");
    // Spawn far more than MAX_TRACKED_SOURCES agents, but re-run the main thread
    // between each spawn (the realistic pattern). Under FIFO, main-thread (inserted
    // first, never moved) is evicted after ~10 distinct spawns regardless of
    // re-access; under LRU each access refreshes its recency so it survives.
    const iterations = 15;
    for (let i = 0; i < iterations; i += 1) {
      record("agent:custom", `agent-${i}`);
      record("compact"); // the main thread keeps working
    }
    // main-thread was accessed iterations+1 times. Under LRU its baseline survives,
    // so callCount accumulates. Under FIFO it is evicted (>10 distinct spawns) and
    // recreated fresh, resetting callCount — destroying the cache-break baseline.
    expect(trackedCallCountForTest("repl_main_thread")).toBe(iterations + 1);
  });
});
