/**
 * Chat Completions request metadata carries a whole-request prompt estimate
 * for direct adapter callers. An admitted call replaces it with the counted
 * input, so building it (a full serialization and normalization of the
 * request) on every admitted model call is pure overhead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateUtf8TokenUnits } from "../../src/llm/token-accounting.js";
import { collectChatCompletionsRequestMetadata } from "../../src/llm/wire/chat-completions.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function request(): Record<string, unknown> {
  return {
    model: "deepseek-flash",
    max_tokens: 64_000,
    messages: [
      { role: "system", content: "You are AgenC." },
      { role: "user", content: "Fix the parser ü." },
      ...Array.from({ length: 200 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "tool",
        content: `step ${index}: ${"export const value = compute(input);\n".repeat(20)}`,
      })),
    ],
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
  };
}

describe("chat completions request metadata", () => {
  it("estimates the whole request when no counted input is given", () => {
    const body = request();
    expect(collectChatCompletionsRequestMetadata(body)).toMatchObject({
      model: "deepseek-flash",
      messageCount: 202,
      maxTokens: 64_000,
      maxTokenField: "max_tokens",
      toolsAttached: true,
      toolCount: 1,
      estimatedPromptTokens: estimateUtf8TokenUnits(
        JSON.stringify({ messages: body.messages, tools: body.tools }),
        1,
      ),
    });
  });

  it("uses the counted input of an admitted call without serializing the request", () => {
    const body = request();
    const estimated = collectChatCompletionsRequestMetadata(body);
    const stringify = vi.spyOn(JSON, "stringify");
    const accounted = collectChatCompletionsRequestMetadata(body, 12_345);
    expect(stringify).not.toHaveBeenCalled();
    expect(accounted).toEqual({ ...estimated, estimatedPromptTokens: 12_345 });
  });
});
