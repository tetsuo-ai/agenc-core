import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import type { LLMMessage } from "../../../src/llm/types.js";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { finalizeCompactionTransaction } from "../../../src/services/compact/finalize-transaction.js";
import { llmMessageToDurableResponseItem, responseItemToLlmMessage } from "../../../src/session/message-history-conversion.js";
import { reconstructFromRollout } from "../../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import { toAgenCRuntimeMessages } from "../../../src/session/runtime-message-conversion.js";
import { createToolResultIntegrity } from "../../../src/session/tool-result-integrity.js";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";
import { isCanonicalBase64Image, syntheticPng } from "../../helpers/redacted-inline-image-fixture.js";

function countBrokenImages(messages: readonly LLMMessage[]): number {
  return messages.reduce((count, message) => count + (Array.isArray(message.content)
    ? message.content.filter(part => part.type === "image_url" && !isCanonicalBase64Image(part.image_url.url)).length
    : 0), 0);
}

describe("independent automatic compaction of durable inline images", () => {
  test.each([false, true])("retained screenshot remains usable after commit and cold reopen, collision=%s", async (collision) => {
    const sessionId = `image-replay-independent-${collision}`;
    const imageContent: LLMMessage["content"] = [
      { type: "text", text: Array.from({ length: 400 }, (_, index) =>
        `synthetic screenshot result ${index}: measured item=${index};\n`).join("") },
      { type: "image_url", image_url: { url: syntheticPng(collision) } },
    ];
    const wire: LLMMessage[] = [
      ...Array.from({ length: 18 }, (_, index): LLMMessage => ({
        role: index % 2 ? "assistant" : "user",
        content: Array.from({ length: 180 }, (_, part) => `item-${index}.${part}: result=${part};\n`).join(""),
      })),
      { role: "assistant", content: "", toolCalls: [
        { id: "synthetic-screen", name: "Screenshot", arguments: "{}" },
      ] },
      { role: "tool", toolName: "Screenshot", toolCallId: "synthetic-screen",
        content: imageContent,
        runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({
          runId: sessionId, toolCallId: "synthetic-screen", content: imageContent,
        }) },
      },
    ];
    expect(countBrokenImages(wire)).toBe(0);
    const harness = createCompactionTransactionHarness([], { sessionId, compactionMode: "automatic" });
    try {
      for (const message of wire) harness.store.appendRollout({
        type: "response_item", payload: llmMessageToDurableResponseItem(message),
      }, { durable: true });
      const result = await compactConversation(toAgenCRuntimeMessages(wire), harness.context);
      expect(harness.provider.chat).toHaveBeenCalled();
      expect(result.transaction).toBeDefined();
      const committed = result.transaction!.committed.replacement_history;
      expect(committed.some(message => message.role === "tool" && message.toolCallId === "synthetic-screen")).toBe(true);
      expect(harness.store.readAll().filter(record => record.type === "compaction_committed")).toHaveLength(1);
      await finalizeCompactionTransaction({
        store: harness.store, attemptId: result.transaction!.attempt_id,
        applyProjection: () => {}, cleanup: () => {},
      });
      const meta = harness.store.readAll().find(record => record.type === "session_meta");
      if (meta?.type !== "session_meta") throw new Error("Missing fixture metadata");
      harness.store.close();
      const reopened = new RolloutStore({
        cwd: meta.payload.cwd, sessionId: meta.payload.sessionId,
        agencVersion: "0.13.0", sessionTempRoot: tmpdir(),
        autoStartScheduler: false, resume: true,
      });
      try {
        reopened.open(meta.payload);
        const restored = reconstructFromRollout(reopened.readAll()).history;
        expect(restored).toEqual(committed);
        expect({
          committed: countBrokenImages(committed.map(responseItemToLlmMessage)),
          coldReopen: countBrokenImages(restored.map(responseItemToLlmMessage)),
        }).toEqual({ committed: 0, coldReopen: 0 });
      } finally { reopened.close(); }
    } finally { harness.close(); }
  });
});
