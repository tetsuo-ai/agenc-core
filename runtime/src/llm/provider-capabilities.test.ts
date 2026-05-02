import { describe, expect, test } from "vitest";

import { LLMProviderError } from "./errors.js";
import { assertProviderStructuredOutputCompatibility } from "./provider-capabilities.js";

const structuredOutput = {
  schema: {
    type: "json_schema" as const,
    name: "answer",
    schema: {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
    },
  },
};

describe("assertProviderStructuredOutputCompatibility", () => {
  test("allows Grok 4 structured outputs with tools", () => {
    expect(() =>
      assertProviderStructuredOutputCompatibility({
        providerName: "grok",
        model: "grok-4-fast",
        structuredOutput,
        toolsRequested: true,
        api: "responses",
      }),
    ).not.toThrow();
  });

  test("rejects Grok code-fast structured outputs with tools", () => {
    expect(() =>
      assertProviderStructuredOutputCompatibility({
        providerName: "grok",
        model: "grok-code-fast-1",
        structuredOutput,
        toolsRequested: true,
        api: "responses",
      }),
    ).toThrow(LLMProviderError);
  });

  test("allows Anthropic structured output alongside regular tool-loop tools", () => {
    expect(() =>
      assertProviderStructuredOutputCompatibility({
        providerName: "anthropic",
        model: "claude-sonnet-4-5",
        structuredOutput,
        toolsRequested: true,
        api: "messages",
      }),
    ).not.toThrow();
  });
});
