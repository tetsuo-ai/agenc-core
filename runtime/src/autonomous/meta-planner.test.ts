import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../utils/logger.js";
import { createMetaPlannerAction } from "./meta-planner.js";
import { StrategicMemory } from "./strategic-memory.js";

function makeMockMemory() {
  const store = new Map<string, unknown>();
  return {
    store,
    backend: {
      name: "mock-memory",
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
        return store.get(key) as T | undefined;
      }),
      delete: vi.fn(async (key: string) => store.delete(key)),
      has: vi.fn(async (key: string) => store.has(key)),
      listKeys: vi.fn(async () => [...store.keys()]),
      addEntry: vi.fn(async () => {}),
      getThread: vi.fn(async () => []),
      query: vi.fn(async () => []),
      deleteThread: vi.fn(async () => 0),
      listSessions: vi.fn(async () => []),
      getDurability: vi.fn(() => ({
        level: "sync" as const,
        supportsFlush: true,
        description: "mock durable",
      })),
      flush: vi.fn(async () => {}),
      clear: vi.fn(async () => store.clear()),
      close: vi.fn(async () => {}),
      healthCheck: vi.fn(async () => true),
    },
  };
}

describe("meta-planner", () => {
  it("uses strategic memory snapshots instead of raw recent thread slices", async () => {
    const { backend, store } = makeMockMemory();
    const strategicMemory = StrategicMemory.fromMemoryBackend(backend as any);
    const staleGoal = await strategicMemory.addGoal({
      title: "Break meta-loop with raw listDir",
      description: "Use raw listDir to inspect the workspace",
      priority: "high",
      source: "meta-planner",
      rationale: "Old noisy goal",
      status: "pending",
    });
    await strategicMemory.goalStore.cancelGoal(staleGoal.goal.id);
    await strategicMemory.addGoal({
      title: "Prune interaction history duplicates",
      description: "Remove duplicate entries from the active interaction history",
      priority: "medium",
      source: "meta-planner",
      rationale: "Already in flight",
      status: "pending",
    });
    await strategicMemory.recordExecutionSummary({
      goalTitle: "Recover daemon status page",
      outcome: "failure",
      summary: "The last recovery attempt timed out after a stale pid mismatch.",
      source: "meta-planner",
    });

    const llm = {
      name: "test-llm",
      chat: async () => ({
        content: JSON.stringify([
          {
            title: "Prune interaction history duplicates",
            description:
              "Remove duplicate entries from the active interaction history",
            priority: "medium",
            rationale: "Already in managed queue",
            suggestedActions: ["dedupe memory"],
            estimatedComplexity: "simple",
          },
          {
            title: "Stabilize delegation workspace contracts",
            description:
              "Replace lossy cwd hints with explicit workspace execution envelopes",
            priority: "high",
            rationale: "Fixes repeated delegation failures",
            suggestedActions: ["add typed execution context"],
            estimatedComplexity: "moderate",
          },
        ]),
      }),
    } as any;

    const action = createMetaPlannerAction({
      llm,
      memory: backend as any,
      strategicMemory,
      traceProviderPayloads: false,
    });

    const result = await action.execute({
      logger: silentLogger,
      sendToChannels: async () => {},
    });

    expect(result.hasOutput).toBe(true);
    expect(backend.query).not.toHaveBeenCalled();

    const active = await strategicMemory.getActiveGoals();
    expect(
      active.some(
        (goal) =>
          goal.title === "Prune interaction history duplicates" &&
          goal.status === "pending",
      ),
    ).toBe(true);
    expect(
      active.some(
        (goal) =>
          goal.title === "Stabilize delegation workspace contracts" &&
          goal.status === "pending",
      ),
    ).toBe(true);
    expect(
      active.filter(
        (goal) => goal.title === "Prune interaction history duplicates",
      ),
    ).toHaveLength(1);

    expect(store.has("goal:active")).toBe(true);
    expect(store.has("goals:active")).toBe(true);
  });

  it("suppresses client tools on the planning LLM call", async () => {
    const { backend } = makeMockMemory();
    const chat = vi.fn().mockResolvedValue({
      content: "[]",
    });
    const llm = {
      name: "test-llm",
      chat,
    } as any;

    const action = createMetaPlannerAction({
      llm,
      memory: backend as any,
      traceProviderPayloads: false,
    });

    await action.execute({
      logger: silentLogger,
      sendToChannels: async () => {},
    });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[1]).toMatchObject({
      toolChoice: "none",
      toolRouting: { allowedToolNames: [] },
      parallelToolCalls: false,
    });
  });
});
