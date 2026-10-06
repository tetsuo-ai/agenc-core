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
      providerReasoningProvenance: {
        provider: "qwen-token-plan",
        model: "qwen3.8-max",
      },
      toolCalls: [{ id: "call-1", name: "FileRead", arguments: "{}" }],
    };
    const durable = llmMessageToDurableResponseItem(source);
    expect(durable.providerReasoning).toEqual({
      version: 2,
      content: reasoning,
      provider: "qwen-token-plan",
      model: "qwen3.8-max",
    });
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
    expect(
      responseItemToLlmMessage(parsed.payload).providerReasoningProvenance,
    ).toEqual({ provider: "qwen-token-plan", model: "qwen3.8-max" });

    const legacyReasoning = responseItemToLlmMessage({
      role: "assistant",
      content: "",
      providerReasoning: { version: 1, content: reasoning },
    });
    expect(legacyReasoning.providerReasoningContent).toBe(reasoning);
    expect(legacyReasoning.providerReasoningProvenance).toBeUndefined();

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
      providerReasoning: {
        version: 2,
        content: reasoning,
        provider: "qwen",
        model: "qwen3.8-max",
      },
    };
    const changed: ResponseItem = {
      ...first,
      providerReasoning: {
        version: 2,
        content: reasoning,
        provider: "qwen-token-plan",
        model: "qwen3.8-max",
      },
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
    expect(() =>
      computeCheckpointPrefixHashV3([
        {
          role: "assistant",
          content: "",
          providerReasoning: {
            version: 2,
            content: reasoning,
            provider: "",
            model: "qwen3.8-max",
          },
        },
      ], 1))
      .toThrow(/invalid provider reasoning replay/u);
  });

  test("drops a replay that redaction would alter and keeps the message, while the sink still refuses such a replay", () => {
    const qwenCredential = [
      "sk-ws-H",
      "WORK123",
      "ABCD",
      "a".repeat(64),
    ].join(".");
    const secretLikeReasoning = `provider state ${qwenCredential}`;
    // Redacting opaque replay state would corrupt it and persisting it raw
    // would leak the match, so the durable record carries the message
    // without its replay instead of failing the turn.
    const durable = llmMessageToDurableResponseItem({
      role: "assistant",
      content: "Setting the password now.",
      providerReasoningContent: secretLikeReasoning,
      toolCalls: [{ id: "call-9", name: "exec_command", arguments: "{}" }],
    });
    expect(durable.providerReasoning).toBeUndefined();
    expect(durable.content).toBe("Setting the password now.");
    expect(durable.toolCalls).toEqual([
      { id: "call-9", name: "exec_command", arguments: "{}" },
    ]);
    expect(llmMessageToCheckpointResponseItem({
      role: "assistant",
      content: "Setting the password now.",
      providerReasoningContent: secretLikeReasoning,
    }).providerReasoning).toBeUndefined();
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
