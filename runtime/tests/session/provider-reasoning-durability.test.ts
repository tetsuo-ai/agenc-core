import { describe, expect, test } from "vitest";

import {
  computeCheckpointPrefixHashV3,
  DurableCheckpointReadError,
} from "../../src/session/durable-checkpoint-reader.js";
import {
  llmMessageToCheckpointResponseItem,
  llmMessageToDurableResponseItem,
  llmMessageToReplacementResponseItem,
  responseItemToLlmMessage,
} from "../../src/session/message-history-conversion.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
  type ResponseItem,
} from "../../src/session/rollout-item.js";

describe("provider reasoning durability", () => {
  const reasoning = "opaque Qwen preserve_thinking replay state";

  test("round-trips replay state through rollout, restart, and replacement projections", () => {
    const source = {
      role: "assistant" as const,
      content: "",
      providerReasoningContent: reasoning,
      toolCalls: [{ id: "call-1", name: "FileRead", arguments: "{}" }],
    };
    const durable = llmMessageToDurableResponseItem(source);
    expect(durable.providerReasoning).toEqual({ version: 1, content: reasoning });
    expect(llmMessageToCheckpointResponseItem(source).providerReasoning)
      .toEqual(durable.providerReasoning);
    expect(llmMessageToReplacementResponseItem(source).providerReasoning)
      .toEqual(durable.providerReasoning);

    const parsed = parseRolloutLine(
      serializeRolloutItem({ type: "response_item", payload: durable }),
    );
    expect(parsed?.type).toBe("response_item");
    if (parsed?.type !== "response_item") throw new Error("wrong rollout item");
    expect(parsed.eventVersion).toBe(2);
    expect(responseItemToLlmMessage(parsed.payload).providerReasoningContent)
      .toBe(reasoning);

    const legacy = parseRolloutLine(
      serializeRolloutItem({
        type: "response_item",
        payload: { role: "assistant", content: "ordinary" },
      }),
    );
    expect(legacy?.eventVersion).toBe(1);
    expect(() =>
      serializeRolloutItem({
        type: "response_item",
        eventVersion: 1,
        payload: durable,
      }))
      .toThrow(/requires rollout eventVersion 2/u);
  });

  test("authenticates replay state in checkpoint prefix hashes", () => {
    const first: ResponseItem = {
      role: "assistant",
      content: "",
      providerReasoning: { version: 1, content: reasoning },
    };
    const changed: ResponseItem = {
      ...first,
      providerReasoning: { version: 1, content: `${reasoning} changed` },
    };
    expect(computeCheckpointPrefixHashV3([first], 1))
      .not.toBe(computeCheckpointPrefixHashV3([changed], 1));
  });

  test("reader rejects malformed or misplaced replay state", () => {
    expect(() =>
      computeCheckpointPrefixHashV3([
        {
          role: "user",
          content: "bad",
          providerReasoning: { version: 1, content: reasoning },
        },
      ], 1))
      .toThrow(DurableCheckpointReadError);
    expect(() =>
      computeCheckpointPrefixHashV3([
        {
          role: "assistant",
          content: "",
          providerReasoning: { version: 1, content: "" },
        },
      ], 1))
      .toThrow(/invalid provider reasoning replay/u);
  });

  test("fails closed instead of mutating replay state during secret redaction", () => {
    const qwenCredential = [
      "sk-ws-H",
      "WORK123",
      "ABCD",
      "a".repeat(64),
    ].join(".");
    const secretLikeReasoning = `provider state ${qwenCredential}`;
    expect(() =>
      llmMessageToDurableResponseItem({
        role: "assistant",
        content: "",
        providerReasoningContent: secretLikeReasoning,
      }))
      .toThrow(/secret redaction would change its opaque content/u);
    expect(() =>
      serializeRolloutItem({
        type: "response_item",
        payload: {
          role: "assistant",
          content: "",
          providerReasoning: { version: 1, content: secretLikeReasoning },
        },
      }))
      .toThrow(/secret redaction would change its opaque content/u);
  });
});
