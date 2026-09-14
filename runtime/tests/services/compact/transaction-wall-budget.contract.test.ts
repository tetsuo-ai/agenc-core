import { afterEach, describe, expect, it, vi } from "vitest";

import type { LLMChatOptions, LLMMessage } from "../../../src/llm/types.js";
import { compactConversationTransactionally } from "../../../src/services/compact/transaction.js";
import { MAX_COMPACTION_WALL_MS } from "../../../src/services/compact/transaction-types.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import {
  createCompactionTransactionHarness,
  createProvider,
  type CompactionTransactionHarness,
} from "../../helpers/compaction-transaction-harness.js";

// One second past the former 300 s bound, where a real grok-4.6 compaction was cut off.
const SLOW_PROVIDER_CALL_MS = 301_000;

const SOURCE: readonly RuntimeMessage[] = Array.from({ length: 8 }, (_, index) => ({
  role: index % 2 === 0 ? "user" as const : "assistant" as const,
  content: `wall-budget-${index}:${"y".repeat(4_000)}`,
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("transactional compaction wall budget", () => {
  it("commits a compaction whose provider call outlasts the former 300 s bound", async () => {
    const harness = slowHarness(SLOW_PROVIDER_CALL_MS);
    try {
      const settled = compact(harness).then(() => "committed", (error: unknown) => error);
      await waitForProviderCall(harness);
      await vi.advanceTimersByTimeAsync(SLOW_PROVIDER_CALL_MS);

      expect(await settled).toBe("committed");
      expect(harness.provider.chat).toHaveBeenCalledTimes(1);
      expect(lifecycle(harness).at(-1)?.type).toBe("compaction_committed");
    } finally {
      harness.close();
    }
  }, 60_000);

  it("still fails a compaction whose provider call exceeds the wall budget", async () => {
    const harness = slowHarness(MAX_COMPACTION_WALL_MS + 60_000);
    try {
      const rejected = expect(compact(harness)).rejects.toThrow(/wall-clock deadline/);
      await waitForProviderCall(harness);
      await vi.advanceTimersByTimeAsync(MAX_COMPACTION_WALL_MS + 1);

      await rejected;
      expect(harness.provider.chat).toHaveBeenCalledTimes(1);
      expect(lifecycle(harness).at(-1)).toMatchObject({
        type: "compaction_failed",
        payload: { reason: "wall_time_exceeded" },
      });
    } finally {
      harness.close();
    }
  }, 60_000);
});

// The harness summariser, answering only after delayMs of fake time and rejecting when the transaction aborts it.
function slowHarness(delayMs: number): CompactionTransactionHarness {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const summariser = createProvider();
  return createCompactionTransactionHarness(SOURCE, {
    compactionMode: "automatic",
    chat: async (messages: LLMMessage[], options?: LLMChatOptions) => {
      const signal = options?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        if (signal !== undefined) {
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        }
      });
      return summariser.chat(messages);
    },
  });
}

function compact(harness: CompactionTransactionHarness) {
  return compactConversationTransactionally(harness.context, {
    customInstructions: "keep the wall budget facts",
    automatic: true,
    messagesToKeep: [],
    completeSourceMessages: SOURCE,
    messagesToSummarize: SOURCE,
    summaryPlacement: "before_keep",
    createBoundaryMarker: () => ({ role: "user", originalRole: "developer", content: "wall budget boundary" }),
    createSummaryMessage: (content) => ({ role: "user", content }),
  });
}

// Yield real event-loop turns (setImmediate is not faked) until the provider is called, so no fake time passes
// before the slow call begins and the deadline cannot fire early.
async function waitForProviderCall(harness: CompactionTransactionHarness): Promise<void> {
  for (let turn = 0; turn < 10_000 && harness.provider.chat.mock.calls.length === 0; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (harness.provider.chat.mock.calls.length === 0) throw new Error("compaction provider was never called");
}

function lifecycle(harness: CompactionTransactionHarness) {
  return harness.store.readAll().filter((item) => item.type.startsWith("compaction_") && item.type !== "compaction_payload_chunk");
}
