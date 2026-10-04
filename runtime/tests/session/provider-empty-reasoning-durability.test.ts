import { describe, expect, test } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { normalizeHistoryMessages } from "../../src/session/session.js";
import {
  llmMessageToCheckpointResponseItem, llmMessageToDurableResponseItem,
  llmMessageToReplacementResponseItem, responseItemToLlmMessage,
} from "../../src/session/message-history-conversion.js";
import { computeCheckpointPrefixHashV3 } from "../../src/session/durable-checkpoint-reader.js";
import { parseRolloutLine, serializeRolloutItem, type ResponseItem } from "../../src/session/rollout-item.js";
import { readCompactionRolloutPayload } from "../../src/session/compaction-event-reader.js";
import { COMPACTION_EVENT_FORMAT_VERSION, COMPACTION_SOURCE_DIGEST_DOMAIN } from "../../src/services/compact/transaction-types.js";
import { canonicalCompactionProjectionMessages } from "../../src/services/compact/projection-digest.js";
import { digestSourceWithDomain } from "../../src/services/compact/summary-v1.js";

const origin = { provider: "zai-coding-plan", model: "glm-5.3-flash" };
const source: LLMMessage = { role: "assistant", content: "", providerReasoningContent: "",
  providerReasoningProvenance: origin, toolCalls: [{ id: "call-1", name: "FileRead", arguments: "{}" }] };
const replay = { version: 2 as const, content: "", ...origin };
const item: ResponseItem = { role: "assistant", content: "", toolCalls: source.toolCalls, providerReasoning: replay };

function rollback(message: ResponseItem) {
  const history = [message];
  return readCompactionRolloutPayload("compaction_rollback_committed", {
    format_version: COMPACTION_EVENT_FORMAT_VERSION, minimum_reader_runtime: "0.14.0",
    attempt_id: "empty-reasoning", recorded_at_ms: 0,
    commit_sha256: "a".repeat(64), source_sha256: "b".repeat(64),
    history_digest: digestSourceWithDomain(COMPACTION_SOURCE_DIGEST_DOMAIN, canonicalCompactionProjectionMessages(history)),
    source_session_id: "session", target_session_id: "session", source_epoch: 1,
    rollback_mode: "same_session", source_history: history,
  });
}

describe("explicit empty GLM reasoning durability", () => {
  test("preserves the bound tuple in durable, checkpoint and replacement projections", () => {
    for (const project of [llmMessageToDurableResponseItem, llmMessageToCheckpointResponseItem, llmMessageToReplacementResponseItem]) {
      const projected = project(source);
      expect(projected.providerReasoning).toEqual(replay);
      const parsed = parseRolloutLine(serializeRolloutItem({ type: "response_item", payload: projected }));
      if (parsed?.type !== "response_item") throw new Error("missing replay record");
      expect(parsed.eventVersion).toBe(2);
      expect(responseItemToLlmMessage(parsed.payload)).toMatchObject({ providerReasoningContent: "", providerReasoningProvenance: origin });
      expect(normalizeHistoryMessages([parsed.payload])[0]).toMatchObject({ providerReasoningContent: "", providerReasoningProvenance: origin });
      expect(computeCheckpointPrefixHashV3([projected], 1)).toBe(computeCheckpointPrefixHashV3([item], 1));
    }
    const { providerReasoning: _omitted, ...withoutReplay } = item;
    expect(computeCheckpointPrefixHashV3([item], 1)).not.toBe(computeCheckpointPrefixHashV3([withoutReplay], 1));
    expect(rollback(item)).toMatchObject({ source_history: [item] });
  });

  test("accepts matching live and durable representations without filling absent metadata", () => {
    const normalized = normalizeHistoryMessages([source, item, { ...source, providerReasoning: replay }]);
    for (const message of normalized) expect(message).toMatchObject({ providerReasoningContent: "", providerReasoningProvenance: origin });
    expect(normalizeHistoryMessages([{ ...source, providerReasoningContent: undefined }])[0]?.providerReasoningContent).toBeUndefined();
  });

  test.each([
    { providerReasoningContent: "", providerReasoningProvenance: undefined },
    { providerReasoningContent: "", providerReasoningProvenance: { provider: "qwen", model: "qwen3.8-max" } },
    { providerReasoningContent: "", providerReasoningProvenance: { provider: "zai", model: "not-glm" } },
    { providerReasoningContent: null },
    { providerReasoningContent: "", providerReasoningProvenance: { provider: "zai" } },
    { providerReasoningContent: "nonempty", providerReasoning: replay },
    { providerReasoningProvenance: { provider: "zai", model: origin.model }, providerReasoning: replay },
    { providerReasoning: { ...replay, model: "glm-5.3" } },
    { providerReasoning: { ...replay, content: null } },
    { providerReasoning: { version: 1, content: "" } },
    { providerReasoning: { version: 1, content: "legacy" } },
    { providerReasoning: { version: 3, content: "", ...origin } },
    { providerReasoning: "malformed" },
    { providerReasoningContent: "", providerReasoningProvenance: undefined, providerReasoning: replay },
    { toolCalls: [] },
  ])("rejects malformed/conflicting/legacy tuples atomically %#", overrides => {
    const message = normalizeHistoryMessages([{ ...source, ...overrides }])[0]!;
    expect(message.providerReasoningContent).toBeUndefined();
    expect(message.providerReasoningProvenance).toBeUndefined();
  });

  test.each([
    { providerReasoning: { version: 1, content: "" } },
    { providerReasoning: { ...replay, provider: "qwen", model: "qwen3.8-max" } },
    { providerReasoning: { ...replay, provider: "" } },
    { providerReasoning: { ...replay, model: "not-glm" } },
    { providerReasoning: { version: 2, content: "", provider: "zai" } },
    { providerReasoning: { ...replay, extra: true } },
    { role: "user" },
    { toolCalls: [] },
  ])("strict checkpoint and compaction readers reject unsupported empty records %#", overrides => {
    const bad = { ...item, ...overrides } as ResponseItem;
    expect(() => computeCheckpointPrefixHashV3([bad], 1)).toThrow();
    expect(() => rollback(bad)).toThrow();
  });

  test("does not upgrade a redacted or legacy replay to empty", () => {
    const secret = ["sk-ws-H", "WORK123", "ABCD", "a".repeat(64)].join(".");
    const redacted = llmMessageToDurableResponseItem({ ...source, providerReasoningContent: `opaque ${secret}` });
    expect(redacted.providerReasoning).toBeUndefined();
    expect(responseItemToLlmMessage(redacted).providerReasoningContent).toBeUndefined();
    expect(normalizeHistoryMessages([redacted])[0]?.providerReasoningContent).toBeUndefined();
    const legacy = { ...item, providerReasoning: { version: 1 as const, content: "old unbound text" } };
    expect(responseItemToLlmMessage(legacy).providerReasoningProvenance).toBeUndefined();
    expect(normalizeHistoryMessages([legacy])[0]?.providerReasoningProvenance).toBeUndefined();
    for (const message of [{ ...source, providerReasoningProvenance: undefined }, { ...source, toolCalls: [] }]) {
      expect(llmMessageToDurableResponseItem(message).providerReasoning).toBeUndefined();
    }
  });
});
