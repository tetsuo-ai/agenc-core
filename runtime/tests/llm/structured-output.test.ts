import { describe, expect, test } from "vitest";

import {
  buildStructuredOutputTextFormat,
  enforceStrictStructuredOutputSchema,
  parseStructuredOutputText,
  parseStructuredOutputValue,
  resolveProviderStructuredOutputMode,
  supportsOpenAIStructuredOutputs,
  supportsXaiStructuredOutputsWithTools,
} from "./structured-output.js";

const SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      format: "uri",
    },
    meta: {
      type: "object",
      properties: {
        confidence: { type: "number" },
      },
    },
  },
  required: ["answer"],
};

describe("structured-output provider capability helpers", () => {
  test("gates xAI structured outputs with tools to Grok 4 family models", () => {
    expect(supportsXaiStructuredOutputsWithTools("grok-4.3")).toBe(true);
    expect(supportsXaiStructuredOutputsWithTools("grok-4.20-reasoning")).toBe(true);
    expect(supportsXaiStructuredOutputsWithTools("grok-code-fast-1")).toBe(false);
  });

  test("keeps structured output support open for current models and closed for known old ones", () => {
    expect(supportsOpenAIStructuredOutputs("gpt-5")).toBe(true);
    expect(supportsOpenAIStructuredOutputs("gpt-4o-2024-08-06")).toBe(true);
    expect(supportsOpenAIStructuredOutputs("gpt-4-turbo")).toBe(false);
  });

  test("resolves provider-specific structured-output modes", () => {
    expect(
      resolveProviderStructuredOutputMode({
        provider: "openai",
        model: "gpt-5",
        api: "responses",
      }),
    ).toBe("native_text_format");
    expect(
      resolveProviderStructuredOutputMode({
        provider: "openai",
        model: "gpt-5",
        api: "chat_completions",
      }),
    ).toBe("chat_response_format");
    expect(
      resolveProviderStructuredOutputMode({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        api: "messages",
      }),
    ).toBe("anthropic_tool_use");
  });

  test("enforces compatible strict JSON schema constraints recursively", () => {
    expect(enforceStrictStructuredOutputSchema(SCHEMA)).toEqual({
      type: "object",
      properties: {
        answer: {
          type: "string",
        },
        meta: {
          type: ["object", "null"],
          properties: {
            // gaphunt3 #11: `confidence` is optional in the input (absent from
            // meta.required), so strict mode forces it into `required` AND
            // widens it to be nullable — preserving "may be absent" semantics.
            confidence: { type: ["number", "null"] },
          },
          additionalProperties: false,
          required: ["confidence"],
        },
      },
      additionalProperties: false,
      required: ["answer", "meta"],
    });
  });

  test("builds text.format payloads with strict schema defaults", () => {
    const format = buildStructuredOutputTextFormat({
      schema: {
        type: "json_schema",
        name: "answer",
        schema: SCHEMA,
      },
    });

    expect(format).toMatchObject({
      type: "json_schema",
      name: "answer",
      strict: true,
      schema: {
        additionalProperties: false,
        required: ["answer", "meta"],
      },
    });
  });

  test("ignores array-shaped union schema branches while validating structured output", () => {
    const schema = {
      type: "object",
      properties: {
        answer: { anyOf: [[], { type: "string" }] },
      },
      required: ["answer"],
    };

    expect(() => parseStructuredOutputValue({ answer: 123 }, "answer", schema)).toThrow(
      /anyOf/,
    );
    expect(() =>
      parseStructuredOutputValue({ answer: "ok" }, "answer", schema),
    ).not.toThrow();
  });

  test("rejects array-shaped structured payloads as non-object results", () => {
    expect(() =>
      parseStructuredOutputText(JSON.stringify([{ answer: "ok" }]), "answer", SCHEMA),
    ).toThrow(/top-level JSON object/);
  });
});
