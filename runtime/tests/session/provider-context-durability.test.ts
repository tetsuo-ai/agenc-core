import { describe, expect, it } from "vitest";
import { computeCheckpointPrefixHashV3, DurableCheckpointReadError } from "../../src/session/durable-checkpoint-reader.js";
import { llmMessageToDurableResponseItem, responseItemToLlmMessage } from "../../src/session/message-history-conversion.js";
import { parseRolloutLine, serializeRolloutItem, type ResponseItem } from "../../src/session/rollout-item.js";
import type { ProviderContextHistory } from "../../src/llm/types.js";

const history: ProviderContextHistory = { version: 1, provider: "openai", model: "gpt-6.1-terra",
  initial: { tools: [], reasoningEffort: "low" } };
const item: ResponseItem = { role: "assistant", content: "READY", providerContextHistory: history };

describe("provider context durability", () => {
  it("authenticates the versioned context and detects every changed configuration", () => {
    const hash = computeCheckpointPrefixHashV3([item], 1);
    for (const context of [undefined, { ...history, model: "gpt-6-luna" },
      { ...history, initial: { tools: [], reasoningEffort: "high" as const } }]) {
      expect(hash).not.toBe(computeCheckpointPrefixHashV3([{ ...item, providerContextHistory: context }], 1));
    }
  });
  it("persists and restores the configuration using the versioned rollout", () => {
    const durable = llmMessageToDurableResponseItem({ role: "assistant", content: "READY", providerContextHistory: history });
    const parsed = parseRolloutLine(serializeRolloutItem({ type: "response_item", payload: durable }));
    expect(parsed?.eventVersion).toBe(2);
    if (parsed?.type !== "response_item") throw new Error("missing record");
    expect(responseItemToLlmMessage(parsed.payload).providerContextHistory).toEqual(history);
    expect(() => computeCheckpointPrefixHashV3([parsed.payload], 1)).not.toThrow();
  });
  it("rejects unknown context fields, versions and non-assistant configuration", () => {
    for (const invalid of [{ ...history, extra: "unknown" }, { ...history, version: 2 },
      { ...history, initial: { ...history.initial, extra: true } }]) {
      expect(() => computeCheckpointPrefixHashV3([{ ...item, providerContextHistory: invalid as ProviderContextHistory }], 1))
        .toThrow(DurableCheckpointReadError);
    }
    expect(() => computeCheckpointPrefixHashV3([{ ...item, role: "user" }], 1)).toThrow(DurableCheckpointReadError);
  });
});
