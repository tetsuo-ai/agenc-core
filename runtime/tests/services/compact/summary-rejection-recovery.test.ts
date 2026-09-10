import { afterEach, describe, expect, test, vi } from "vitest";
import { autoCompactIfNeeded } from "../../../src/services/compact/autoCompact.js";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { CompactionFailurePersistenceError, CompactionSummaryRejectedError } from "../../../src/services/compact/transaction-types.js";
import { reduceAll } from "../../../src/session/event-log-reducer.js";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";

afterEach(() => vi.restoreAllMocks());

const source = Array.from({ length: 8 }, (_, index) => ({
  role: index % 2 === 0 ? "user" as const : "assistant" as const,
  content: `Original message ${index}: ${"preserve exact history ".repeat(150)}`,
}));

function createRejectedSummaryHarness() {
  return createCompactionTransactionHarness(source, {
    compactionMode: "automatic",
    chat: async () => ({
      content: JSON.stringify({
        narrative: "invalid summary",
        facts: [{ id: "fact-1", text: "fabricated fact", source_ref_ids: ["unplanned-ref"] }],
        open_actions: [],
        tool_pairs: [],
      }),
      toolCalls: [],
      usage: { promptTokens: 128, completionTokens: 128, totalTokens: 256 },
      model: "grok-4.5",
      finishReason: "stop",
    }),
  });
}

describe("durably rejected summaries can defer to context admission", () => {
  test("the real transaction supplies typed evidence and retains every original message", async () => {
    const harness = createRejectedSummaryHarness();
    try {
      const before = reduceAll(harness.store.readAll()).state.history;
      await expect(compactConversation(source, harness.context))
        .rejects.toBeInstanceOf(CompactionSummaryRejectedError);
      expect(reduceAll(harness.store.readAll()).state.history).toEqual(before);
      expect(harness.store.readAll().filter((item) =>
        item.type === "compaction_intent" || item.type === "compaction_failed" || item.type === "compaction_committed"))
        .toMatchObject([
          { type: "compaction_intent" },
          { type: "compaction_failed", payload: { reason: "provenance_invalid" } },
        ]);
      expect(() => harness.store.assertCompactionProjectionReady()).not.toThrow();
      const lease = harness.store.acquireCompactionLease("after-rejected-summary");
      await lease.release();
    } finally {
      harness.close();
    }
  });

  test("the automatic dispatcher exposes a bounded advisory refusal, never a replacement", async () => {
    const harness = createRejectedSummaryHarness();
    try {
      const before = reduceAll(harness.store.readAll()).state.history;
      const result = await autoCompactIfNeeded(source, harness.context, undefined, "normal", undefined, 0, { force: true });
      expect(result).toMatchObject({
        wasCompacted: false,
        advisoryFailure: "summary_rejected",
        consecutiveFailures: 1,
      });
      expect(result.compactionResult).toBeUndefined();
      expect(harness.provider.chat).toHaveBeenCalledOnce();
      expect(reduceAll(harness.store.readAll()).state.history).toEqual(before);
    } finally {
      harness.close();
    }
  });

  test("failure-event persistence errors are not safe advisory outcomes", async () => {
    const harness = createRejectedSummaryHarness();
    try {
      vi.spyOn(harness.store, "recordFailure").mockImplementation(() => {
        throw new Error("disk unavailable");
      });
      const before = reduceAll(harness.store.readAll()).state.history;
      await expect(autoCompactIfNeeded(source, harness.context, undefined, "normal", undefined, 0, { force: true }))
        .rejects.toBeInstanceOf(CompactionFailurePersistenceError);
      expect(reduceAll(harness.store.readAll()).state.history).toEqual(before);
      expect(harness.store.readAll().some((item) => item.type === "compaction_committed"))
        .toBe(false);
    } finally {
      harness.close();
    }
  });
});
