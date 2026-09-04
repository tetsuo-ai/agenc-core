import { describe, expect, it, vi } from "vitest";
import { AsyncLock } from "../utils/async-lock.js";
import type { RolloutItem } from "./rollout-item.js";
import type { Session } from "./session.js";
import {
  isSessionMemoryExtractionState,
  latestPersistedMemoryExtractionState,
  persistMemoryExtractionState,
  readMemoryExtractionState,
  restorePersistedMemoryExtractionState,
} from "./memory-extraction-state.js";

function sessionWith(opts: {
  readonly state?: boolean;
  readonly record?: (item: unknown) => Promise<void>;
}): Session {
  return {
    conversationId: "conv-cadence",
    ...(opts.state === false
      ? {}
      : { state: new AsyncLock<Record<string, unknown>>({}) }),
    services: {
      ...(opts.record !== undefined ? { rollout: { record: opts.record } } : {}),
    },
  } as unknown as Session;
}

function cadenceItem(
  memoryRoot: string,
  processedVisibleCount: number,
  turnsSinceLastExtraction: number,
): RolloutItem {
  return {
    type: "session_state",
    payload: {
      memoryExtraction: {
        memoryRoot,
        processedVisibleCount,
        turnsSinceLastExtraction,
      },
    },
  };
}

describe("memory extraction cadence slot", () => {
  it("reads the newest persisted cadence per memory root and skips other slots", () => {
    const items: RolloutItem[] = [
      cadenceItem("/m/a", 2, 1),
      {
        type: "session_state",
        payload: {
          agentTask: { agentRuntimeId: "r", taskId: "t", registeredAt: "now" },
        },
      },
      cadenceItem("/m/b", 4, 0),
      { type: "session_state", payload: {} },
      cadenceItem("/m/a", 6, 2),
      // Malformed slot from a corrupt line: skipped, never restored.
      cadenceItem("/m/a", -1, 0),
    ];

    expect([...latestPersistedMemoryExtractionState(items).entries()]).toEqual([
      [
        "/m/a",
        { memoryRoot: "/m/a", processedVisibleCount: 6, turnsSinceLastExtraction: 2 },
      ],
      [
        "/m/b",
        { memoryRoot: "/m/b", processedVisibleCount: 4, turnsSinceLastExtraction: 0 },
      ],
    ]);
  });

  it("accepts only a complete slot with non-negative integer counts", () => {
    expect(
      isSessionMemoryExtractionState({
        memoryRoot: "/m",
        processedVisibleCount: 1,
        turnsSinceLastExtraction: 0,
      }),
    ).toBe(true);
    for (const bad of [
      null,
      {},
      { memoryRoot: "", processedVisibleCount: 1, turnsSinceLastExtraction: 0 },
      { memoryRoot: "/m", processedVisibleCount: 1.5, turnsSinceLastExtraction: 0 },
      { memoryRoot: "/m", processedVisibleCount: 1, turnsSinceLastExtraction: -1 },
      { memoryRoot: "/m", processedVisibleCount: "1", turnsSinceLastExtraction: 0 },
      { memoryRoot: "/m", processedVisibleCount: 1 },
    ]) {
      expect(isSessionMemoryExtractionState(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("persists to session state and the rollout, and reads back what it wrote", async () => {
    const record = vi.fn(async () => {});
    const session = sessionWith({ record });
    const state = {
      memoryRoot: "/m/a",
      processedVisibleCount: 3,
      turnsSinceLastExtraction: 1,
    };

    await persistMemoryExtractionState(session, state);

    expect(record).toHaveBeenCalledWith({
      type: "session_state",
      payload: { memoryExtraction: state },
    });
    await expect(readMemoryExtractionState(session, "/m/a")).resolves.toEqual(
      state,
    );
    await expect(
      readMemoryExtractionState(session, "/m/b"),
    ).resolves.toBeUndefined();
  });

  it("restores the newest persisted cadence into a resumed session", async () => {
    const session = sessionWith({});
    await restorePersistedMemoryExtractionState(session, [
      cadenceItem("/m/a", 2, 1),
      cadenceItem("/m/a", 5, 2),
    ]);
    await expect(readMemoryExtractionState(session, "/m/a")).resolves.toEqual({
      memoryRoot: "/m/a",
      processedVisibleCount: 5,
      turnsSinceLastExtraction: 2,
    });
  });

  it("is a no-op for sessions without a state lock or a rollout recorder", async () => {
    const bare = sessionWith({ state: false });
    await expect(
      persistMemoryExtractionState(bare, {
        memoryRoot: "/m",
        processedVisibleCount: 1,
        turnsSinceLastExtraction: 1,
      }),
    ).resolves.toBeUndefined();
    await expect(readMemoryExtractionState(bare, "/m")).resolves.toBeUndefined();
    await expect(
      restorePersistedMemoryExtractionState(bare, [cadenceItem("/m", 1, 1)]),
    ).resolves.toBeUndefined();
  });
});
