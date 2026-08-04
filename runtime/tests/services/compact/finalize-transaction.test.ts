import { describe, expect, it, vi } from "vitest";

import {
  CompactionCleanupPendingError,
  finalizeCompactionTransaction,
} from "../../../src/services/compact/finalize-transaction.js";
import { CompactionReconstructionRequiredError } from "../../../src/services/compact/transaction-types.js";

function store(events: string[]) {
  return {
    markProjectionComplete: vi.fn(() => events.push("projection_complete")),
    markProjectionFailed: vi.fn((_: string, reason: unknown): never => {
      events.push("projection_failed");
      throw new CompactionReconstructionRequiredError("attempt", { cause: reason });
    }),
    markCleanupComplete: vi.fn(() => events.push("cleanup_complete")),
    markCleanupPending: vi.fn(() => events.push("cleanup_pending")),
  };
}

describe("compaction transaction finalizer", () => {
  it("projects, acknowledges, cleans, and completes in order", async () => {
    const events: string[] = [];
    await finalizeCompactionTransaction({
      store: store(events),
      attemptId: "attempt",
      applyProjection: () => events.push("projection"),
      cleanup: () => events.push("cleanup"),
    });

    expect(events).toEqual([
      "projection",
      "projection_complete",
      "cleanup",
      "cleanup_complete",
    ]);
  });

  it("poisons a committed attempt when projection fails", async () => {
    const events: string[] = [];
    await expect(finalizeCompactionTransaction({
      store: store(events),
      attemptId: "attempt",
      applyProjection: () => {
        events.push("projection");
        throw new Error("projection broke");
      },
      cleanup: () => events.push("cleanup"),
    })).rejects.toBeInstanceOf(CompactionReconstructionRequiredError);

    expect(events).toEqual(["projection", "projection_failed"]);
  });

  it("records pending cleanup without poisoning the projection", async () => {
    const events: string[] = [];
    await expect(finalizeCompactionTransaction({
      store: store(events),
      attemptId: "attempt",
      applyProjection: () => events.push("projection"),
      cleanup: () => {
        events.push("cleanup");
        throw new Error("cleanup broke");
      },
    })).rejects.toBeInstanceOf(CompactionCleanupPendingError);

    expect(events).toEqual([
      "projection",
      "projection_complete",
      "cleanup",
      "cleanup_pending",
    ]);
  });

  it("requires reconstruction only when cleanup-pending cannot be recorded", async () => {
    const events: string[] = [];
    const failingStore = store(events);
    failingStore.markCleanupPending.mockImplementation(() => {
      events.push("cleanup_pending_failed");
      throw new Error("journal unavailable");
    });

    await expect(finalizeCompactionTransaction({
      store: failingStore,
      attemptId: "attempt",
      applyProjection: () => events.push("projection"),
      cleanup: () => {
        events.push("cleanup");
        throw new Error("cleanup broke");
      },
    })).rejects.toBeInstanceOf(CompactionReconstructionRequiredError);

    expect(events).toEqual([
      "projection",
      "projection_complete",
      "cleanup",
      "cleanup_pending_failed",
    ]);
  });
});
