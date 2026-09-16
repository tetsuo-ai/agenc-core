import { describe, expect, it } from "vitest";
import { createTokenAccountingRequest, estimateTokenAccountingRequest } from "../../../src/llm/token-accounting.js";
import { estimateMessagesTokens } from "../../../src/services/compact/_deps/runtime.js";
import { toAgenCRuntimeMessages } from "../../../src/session/runtime-message-conversion.js";
import { canonicalizeJson } from "../../../src/services/compact/summary-v1.js";
import { buildCompactionMapReducePlan } from "../../../src/services/compact/plan.js";
import type { CompactionActiveHistoryRefV1, CompactionSourceAuthorityV1 } from "../../../src/services/compact/transaction-types.js";
import type { CompactContext, RuntimeMessage } from "../../../src/services/compact/types.js";
import type { LLMMessage } from "../../../src/llm/types.js";

describe("independent synthetic long-context regressions", () => {
  it("counts retained provider reasoning in compaction pressure just as admission does", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Synthetic task" },
      { role: "assistant", content: "Checking", providerReasoningContent: "x".repeat(2_400_000),
        toolCalls: [{ id: "synthetic-call", name: "Read", arguments: '{"path":"/app/synthetic"}' }] },
      { role: "tool", toolCallId: "synthetic-call", toolName: "Read", content: "Synthetic result" },
    ];
    const options = { mainLoopModel: "glm-5.3", contextWindowTokens: 950_000, maxOutputTokens: 131_072 };
    const direct = estimateTokenAccountingRequest(createTokenAccountingRequest({
      provider: "zai-coding-plan", model: "glm-5.3", messages, options,
    }));
    const compact = estimateMessagesTokens(toAgenCRuntimeMessages(messages), {
      provider: { name: "zai-coding-plan" }, options,
    } as CompactContext);
    console.log(JSON.stringify({ directInput: direct.inputTokens, directTotal: direct.totalTokens,
      compactTotal: compact, threshold: 712_500 }));
    expect(compact).toBe(direct.totalTokens);
  });

  it("plans a long source without applying the provider-output node ceiling before any provider call", () => {
    const messages: RuntimeMessage[] = Array.from({ length: 2_000 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user", originalRole: i % 2 ? "assistant" : "user",
      content: `synthetic item ${i}`,
    }));
    const refs: CompactionActiveHistoryRefV1[] = messages.map((message, index) => ({
      kind: "rollout_span", ref_id: `synthetic:message:${index + 1}`,
      source_binding: "rollout:/synthetic#epoch:1", first_sequence: index + 1,
      last_sequence: index + 1, sha256: "a".repeat(64), history_index: index,
      record_message_index: 0, encoded_bytes: Buffer.byteLength(canonicalizeJson(message)),
    }));
    const source: CompactionSourceAuthorityV1 = {
      format_version: 1, attempt_id: "synthetic", session_id: "synthetic-session", epoch: 1,
      source_binding: "rollout:/synthetic#epoch:1", first_sequence: 1,
      last_sequence: messages.length, source_sha256: "a".repeat(64),
      source_bytes: messages.reduce((sum, message) => sum + Buffer.byteLength(String(message.content)), 0),
      history_digest: "a".repeat(64), active_history_refs: refs,
    };
    // This is the actual input planner. No model implementation is supplied,
    // so failure here cannot be blamed on malformed/oversized model output.
    const plan = () => buildCompactionMapReducePlan(messages, {
      context: { options: { contextWindowTokens: 950_000, maxOutputTokens: 4_000 } } as CompactContext,
      source, messageSourceRefs: refs, providerName: "zai-coding-plan", model: "glm-5.3",
      systemPrompts: { map: "summarize", reduce: "reduce", final: "return a bounded summary" },
    });
    expect(() => {
      try { return plan(); }
      catch (error) {
        console.log(JSON.stringify({ check: "input_planning_failure", sourceBytes: source.source_bytes,
          messageCount: messages.length, stack: error instanceof Error ? error.stack : String(error) }));
        throw error;
      }
    }).not.toThrow();
  });
});
