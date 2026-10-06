import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import { runContextCollapseOverflowRecovery } from "../../src/phases/post-sample-recovery.js";
import type { RuntimeMessage } from "../../src/services/compact/types.js";
import {
  boundContextImageBytes,
  OMITTED_IMAGE_TEXT,
} from "../../src/session/query-image-budget.js";
import { withholdImagesForModel } from "../../src/session/query-image-safety.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { createCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";
import { mkCtx } from "../fixtures.js";

// 1x1 PNG, complete.
const IMAGE_URL = `data:image/png;base64,${Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
).toString("base64")}`;

function imageUrls(messages: readonly LLMMessage[]): string[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === "image_url" ? [part.image_url.url] : [])
      : []);
}

function collapseHistory(sessionId: string): LLMMessage[] {
  const toolContent: LLMMessage["content"] = [
    { type: "text", text: "Read image chart.png (67B, image/png)" },
    { type: "image_url", image_url: { url: IMAGE_URL } },
  ];
  const filler: LLMMessage[] = Array.from({ length: 16 }, (_, index) =>
    index % 2 === 0
      ? { role: "user" as const, content: index === 0 ? `old ${"x".repeat(8_000)}` : `question ${index}` }
      : { role: "assistant" as const, content: `answer ${index}` });
  // The last four messages are the verbatim tail the collapse keeps.
  return [
    ...filler,
    {
      role: "user",
      content: [
        { type: "text", text: "compare with this" },
        { type: "image_url", image_url: { url: IMAGE_URL } },
      ],
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc-chart", name: "FileRead", arguments: "{}" }],
    },
    {
      role: "tool",
      toolCallId: "tc-chart",
      toolName: "FileRead",
      content: toolContent,
      runtimeOnly: {
        toolResultIntegrity: createToolResultIntegrity({
          runId: sessionId,
          toolCallId: "tc-chart",
          content: toolContent,
        }),
      },
    },
    { role: "assistant", content: "done" },
  ];
}

// Review finding: a 413 collapse compacts the request projection. With the
// image notes of a text-only model in it, a user message no longer matched
// its canonical record (the collapse failed with pin_failed), and a note in
// the retained tail could have become durable history.
describe("a 413 collapse compacts the images history holds, not the request notes", () => {
  test("a text-only model's notes neither break the collapse nor become durable", async () => {
    const sessionId = "image-notes-collapse";
    const history = collapseHistory(sessionId);
    const harness = createCompactionTransactionHarness(history as RuntimeMessage[], {
      sessionId,
      compactionMode: "automatic",
    });
    try {
      const state = buildInitialTurnState(mkCtx(), { role: "user", content: "continue" });
      state.messages = [...history];
      // The request exactly as the sampling boundary builds it for a
      // text-only model: both images replaced by notes.
      state.messagesForQuery = withholdImagesForModel(
        history,
        {
          imageInput: "unsupported",
          modelLabel: "deepseek/deepseek-v4-pro",
          route: "deepseek/deepseek-v4-pro",
        },
        undefined,
      ).messages;
      expect(imageUrls(state.messagesForQuery)).toEqual([]);

      const recovered = await runContextCollapseOverflowRecovery({
        state,
        session: harness.session,
      });

      expect(recovered).toEqual({ kind: "applied", reason: "context_collapse", tier: "standard" });
      expect(imageUrls(state.messages)).toEqual([IMAGE_URL, IMAGE_URL]);
      expect(JSON.stringify(state.messages)).not.toContain("[Image not shown");
      const commit = harness.store.readAll().findLast(
        (item) => item.type === "compaction_committed",
      );
      const durable = JSON.stringify(commit);
      expect(durable).toContain(IMAGE_URL);
      expect(durable).not.toContain("[Image not shown");
    } finally {
      harness.close();
    }
  });

  test("the image budget's placeholders neither break the collapse nor become durable", async () => {
    // Review finding: the byte budget replaces older images with a
    // placeholder in the request too. Only this module's notes were turned
    // back, so a user message whose image the budget left out had no
    // canonical match and the collapse failed with pin_failed.
    const sessionId = "image-budget-collapse";
    const history = collapseHistory(sessionId);
    const harness = createCompactionTransactionHarness(history as RuntimeMessage[], {
      sessionId,
      compactionMode: "automatic",
    });
    try {
      const state = buildInitialTurnState(mkCtx(), { role: "user", content: "continue" });
      state.messages = [...history];
      // Room for the newest image only: the user's older one is left out.
      const bounded = boundContextImageBytes(history, IMAGE_URL.length);
      expect(bounded.omitted).toBe(1);
      state.messagesForQuery = bounded.messages;
      expect(imageUrls(state.messagesForQuery)).toEqual([IMAGE_URL]);

      const recovered = await runContextCollapseOverflowRecovery({
        state,
        session: harness.session,
      });

      expect(recovered).toEqual({ kind: "applied", reason: "context_collapse", tier: "standard" });
      expect(imageUrls(state.messages)).toEqual([IMAGE_URL, IMAGE_URL]);
      expect(JSON.stringify(state.messages)).not.toContain(OMITTED_IMAGE_TEXT);
      const commit = harness.store.readAll().findLast(
        (item) => item.type === "compaction_committed",
      );
      const durable = JSON.stringify(commit);
      expect(durable).toContain(IMAGE_URL);
      expect(durable).not.toContain(OMITTED_IMAGE_TEXT);
    } finally {
      harness.close();
    }
  });
});
