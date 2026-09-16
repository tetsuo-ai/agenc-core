import { describe, expect, it } from "vitest";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { llmMessageToDurableResponseItem } from "../../../src/session/message-history-conversion.js";
import { toAgenCRuntimeMessages } from "../../../src/session/runtime-message-conversion.js";
import { createToolResultIntegrity } from "../../../src/session/tool-result-integrity.js";
import type { LLMMessage } from "../../../src/llm/types.js";

const syntheticSecret = ["sk-ws-H", "WORK123", "ABCD", "a".repeat(64)].join(".");

describe("durable opaque-replay redaction and compaction source identity", () => {
  for (const mode of ["absent", "ordinary", "redacted", "redacted-kept", "redacted-legacy", "redacted-provider", "redacted-model", "tampered-content", "tampered-replay"] as const) {
    it(`compacts the unchanged live history after ${mode} replay persistence`, async () => {
      const sessionId = `redacted-replay-pin-${mode}`;
      const redactedMode = mode.startsWith("redacted");
      const normalizedSecret = `SK-proj-${"a".repeat(64)}`;
      const toolResult = Array.from({ length: 400 }, (_, part) => `read-${part}: result=${part};\n`).join("");
      const wire: LLMMessage[] = [
        { role: "user", content: Array.from({ length: 400 }, (_, part) => `task-${part}: step=${part};\n`).join("") },
        {
          role: "assistant", content: "",
          toolCalls: [{ id: "synthetic-read", name: "Read", arguments: '{"path":"/synthetic"}' }],
          ...(mode !== "absent" ? {
            providerReasoningContent: redactedMode && mode !== "redacted-provider" && mode !== "redacted-model"
              ? `provider state ${syntheticSecret}` : "ordinary replay state",
            ...(mode !== "redacted-legacy" ? {
              providerReasoningProvenance: {
                provider: mode === "redacted-provider" ? normalizedSecret : "deepseek",
                model: mode === "redacted-model" ? normalizedSecret : "deepseek-flash",
              },
            } : {}),
          } : {}),
        },
        {
          role: "tool", content: toolResult, toolCallId: "synthetic-read", toolName: "Read",
          runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({
            runId: sessionId, toolCallId: "synthetic-read", content: toolResult,
          }) },
        },
        ...Array.from({ length: 16 }, (_, index): LLMMessage => ({
          role: index % 2 ? "assistant" : "user",
          content: Array.from({ length: 140 }, (_, part) => `item-${index}.${part}: result=${part};\n`).join(""),
        })),
      ];
      if (mode === "redacted-kept") wire.push(...wire.splice(1, 2));
      const replayIndex = mode === "redacted-kept" ? wire.length - 2 : 1;
      const durable = wire.map(llmMessageToDurableResponseItem);
      expect(Boolean(durable[replayIndex]!.providerReasoning)).toBe(mode !== "absent" && !redactedMode);
      if (mode === "tampered-content") wire[1] = { ...wire[1]!, content: "forged assistant content" };
      if (mode === "tampered-replay") wire[1] = { ...wire[1]!, providerReasoningContent: "different ordinary replay" };
      const caller = toAgenCRuntimeMessages(wire);
      // 27B is the empty text-array envelope, not newly invented assistant text.
      if (mode !== "tampered-content") expect(Buffer.byteLength(JSON.stringify(caller[replayIndex]!.content))).toBe(27);
      const harness = createCompactionTransactionHarness([], { sessionId });
      try {
        for (const payload of durable) {
          harness.store.appendRollout({ type: "response_item", payload }, { durable: true });
        }
        if (mode.startsWith("tampered-")) {
          await expect(compactConversation(caller, harness.context)).rejects.toMatchObject({ reason: "pin_failed" });
          expect(harness.provider.chat).not.toHaveBeenCalled();
          expect(harness.store.readAll().filter((record) => record.type === "compaction_committed")).toHaveLength(0);
          return;
        }
        const result = await compactConversation(caller, harness.context);
        expect(result.transaction).toBeDefined();
        expect(JSON.stringify(result.transaction)).not.toContain(syntheticSecret);
        if (mode === "redacted-provider" || mode === "redacted-model") {
          expect(JSON.stringify(result.transaction)).not.toContain(normalizedSecret.toLowerCase());
        }
        expect(harness.provider.chat).toHaveBeenCalled();
        const records = harness.store.readAll();
        expect(records.filter((record) => record.type === "compaction_committed")).toHaveLength(1);
        expect(JSON.stringify(records)).not.toContain(syntheticSecret);
        expect(JSON.stringify(harness.provider.chat.mock.calls)).not.toContain(syntheticSecret);
      } catch (error) {
        console.log(JSON.stringify({ mode, providerCalls: harness.provider.chat.mock.calls.length,
          name: error instanceof Error ? error.name : "unknown",
          reason: (error as { reason?: string }).reason,
          message: error instanceof Error ? error.message : "unknown" }));
        throw error;
      } finally { harness.close(); }
    });
  }
});
