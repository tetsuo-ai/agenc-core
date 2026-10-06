import { describe, expect, it } from "vitest";
import { parseChatCompletionsResponse } from "../../../src/llm/wire/chat-completions.js";
import type { ChatCompletionsRequestOptions } from "../../../src/llm/wire/chat-completions.js";

const MODEL = "glm-5.3-flash";
const TOOL = {
  type: "function" as const,
  function: { name: "echo", description: "Echo", parameters: { type: "object" } },
};

function request(
  overrides: Partial<ChatCompletionsRequestOptions> = {},
): ChatCompletionsRequestOptions {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "inspect" }],
    tools: [TOOL],
    // The hints Z.AI GLM sessions get on main (capability-gating.ts): known-empty
    // reasoning is established only when the provider replays reasoning content.
    providerCapabilityHints: {
      replaysReasoningContent: true,
      replaysReasoningContentOnlyForAdjacentToolContinuation: true,
      reasoningContentProvenance: { provider: "zai", model: MODEL },
    },
    ...overrides,
  };
}

function toolCallPayload(
  reasoning: unknown,
  finish = "tool_calls",
  servedModel: unknown = MODEL,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "echo", arguments: "{}" },
    }],
  };
  if (reasoning !== undefined) message.reasoning_content = reasoning;
  return {
    model: servedModel,
    choices: [{ message, finish_reason: finish }],
  };
}

describe("parseChatCompletionsResponse GLM reconstruction", () => {
  it("establishes known-empty reasoning only at a complete tool-call boundary", () => {
    const parsed = parseChatCompletionsResponse(MODEL, toolCallPayload(""), request());
    expect(parsed.providerReasoningContent).toBe("");
    expect(parsed.toolCalls).toHaveLength(1);
  });

  it("treats a missing reasoning field the same as an explicit empty string", () => {
    expect(parseChatCompletionsResponse(MODEL, toolCallPayload(undefined), request())
      .providerReasoningContent).toBe("");
  });

  it.each([
    ["discarded stream fragment", { discardedReasoningContent: true, conflictingReasoningModel: false }],
    ["conflicting stream model", { discardedReasoningContent: false, conflictingReasoningModel: true }],
  ] as const)("does not upgrade a %s", (_name, reconstruction) => {
    expect(parseChatCompletionsResponse(
      MODEL, toolCallPayload(""), request(), reconstruction,
    ).providerReasoningContent).toBeUndefined();
  });

  it("does not upgrade a text-only stop or a non-string discarded field", () => {
    expect(parseChatCompletionsResponse(
      MODEL, toolCallPayload("", "stop"), request(),
    ).providerReasoningContent).toBeUndefined();
    expect(parseChatCompletionsResponse(
      MODEL, toolCallPayload({ truncated: true }), request(),
    ).providerReasoningContent).toBeUndefined();
  });

  it("does not bind empty reasoning when the served model disagrees", () => {
    expect(parseChatCompletionsResponse(
      MODEL, toolCallPayload("", "tool_calls", "glm-5.3"), request(),
    ).providerReasoningContent).toBeUndefined();
  });

  it("does not bind empty reasoning for a non-GLM provenance", () => {
    expect(parseChatCompletionsResponse(MODEL, toolCallPayload(""), request({
      providerCapabilityHints: {
        replaysReasoningContentOnlyForAdjacentToolContinuation: true,
        reasoningContentProvenance: { provider: "qwen", model: MODEL },
      },
    })).providerReasoningContent).toBeUndefined();
  });
});
