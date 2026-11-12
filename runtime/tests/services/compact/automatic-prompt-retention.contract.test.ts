import { afterEach, describe, expect, it } from "vitest";

import { compactConversation } from "../../../src/services/compact/compact.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import {
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../../helpers/compaction-transaction-harness.js";

const TASK = [
  "TASK: build the renderer with soft shadows.",
  "Write the image encoder yourself and keep every scene in its own module.",
  "Render three scenes at two camera angles each and check every picture before you finish.",
  "The floor is a checkerboard, the light is an area light, and the mirror sphere must show the other spheres.",
].join(" ");
const CORRECTION = "CORRECTION: the floor must be a checkerboard, not a solid color.";

/** A session with a task, a later correction, long assistant work between them and a live request. */
function source(): RuntimeMessage[] {
  return Array.from({ length: 40 }, (_, index): RuntimeMessage => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    ...(index % 2 === 0 ? { runtimeOnly: { userMessageId: `prompt-${index}` } } : {}),
    content: index === 0
      ? TASK
      : index === 20
        ? CORRECTION
        : index % 2 === 0
          ? `next step ${index}`
          : `work-${index}:${"x".repeat(3_000)}`,
  }));
}

/**
 * An automatic compaction summarized every earlier user message. After a
 * compaction in a continued session the original task was gone from the
 * request: the model worked from a summary of what it was asked to do.
 */
describe("automatic compaction keeps what the user typed", () => {
  let harness: CompactionTransactionHarness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  it("keeps the task and later prompts verbatim and summarizes the work between them", async () => {
    const messages = source();
    harness = createCompactionTransactionHarness(messages, {
      sessionId: "prompt-retention-contract",
      contextWindowTokens: 200_000,
      compactionMode: "automatic",
    });

    const result = await compactConversation(messages, harness.context, "");

    expect(result.transaction).toBeDefined();
    const committed = harness.store.readAll().find((item) => item.type === "compaction_committed") as
      { payload: { replacement_history: Array<{ role?: string; content?: unknown }> } } | undefined;
    expect(committed).toBeDefined();
    const history = committed!.payload.replacement_history;
    const texts = history.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    // The task comes first, unchanged, and the correction is still there word for word.
    expect(texts[0]).toBe(TASK);
    expect(texts).toContain(CORRECTION);
    expect(texts.indexOf(CORRECTION)).toBeGreaterThan(texts.findIndex((text) => text.includes("agenc_compaction")));
    // The old assistant work is summarized away.
    expect(texts.some((text) => text.startsWith("work-1:"))).toBe(false);
    expect(texts.some((text) => text.startsWith("work-19:"))).toBe(false);
    expect(history.length).toBeLessThan(messages.length);
  });
});
