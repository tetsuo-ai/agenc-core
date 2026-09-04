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

  test.each([
    "muse-spark-1.3",
    "muse-spark-1.3-contributor",
    "muse-spark-1.2",
    "muse-spark-1.2-contributor",
    "muse-spark-1.1",
  ])("uses chat response_format for Meta model %s", (model) => {
    expect(
      resolveProviderStructuredOutputMode({
        provider: "meta",
        model,
        api: "chat_completions",
      }),
    ).toBe("chat_response_format");
  });

  test("keeps non-chat and unknown Meta structured output fail-closed", () => {
    expect(
      resolveProviderStructuredOutputMode({
        provider: "meta",
        model: "muse-spark-1.3",
        api: "responses",
      }),
    ).toBe("unsupported");
    expect(
      resolveProviderStructuredOutputMode({
        provider: "meta",
        model: "muse-spark-future",
        api: "chat_completions",
      }),
    ).toBe("unsupported");
  });

  test.each(["qwen", "qwen-token-plan"])(
    "keeps JSON Schema disabled on the %s Singapore route",
    (provider) => {
      expect(
        resolveProviderStructuredOutputMode({
          provider,
          model: "qwen3.8-max",
          api: "chat_completions",
        }),
      ).toBe("unsupported");
      expect(
        resolveProviderStructuredOutputMode({
          provider,
          model: "qwen3.6-flash",
          api: "chat_completions",
        }),
      ).toBe("unsupported");
    },
  );

  test("uses JSON Schema object equality rather than serialized key order", () => {
    expect(parseStructuredOutputValue(
      { result: { b: 2, a: 1 } },
      "ordered_enum",
      {
        type: "object",
        properties: {
          result: { enum: [{ a: 1, b: 2 }] },
        },
        required: ["result"],
      },
    ).parsed).toEqual({ result: { b: 2, a: 1 } });
  });

  test("isolates validators when independent schemas reuse the same $id", () => {
    const first = {
      $id: "https://schemas.agenc.test/shared-result",
      type: "object",
      properties: { first: { type: "string" } },
      required: ["first"],
    };
    const second = {
      $id: "https://schemas.agenc.test/shared-result",
      type: "object",
      properties: { second: { type: "integer", minimum: 1 } },
      required: ["second"],
    };

    expect(parseStructuredOutputValue({ first: "ok" }, "first", first).parsed)
      .toEqual({ first: "ok" });
    expect(parseStructuredOutputValue({ second: 2 }, "second", second).parsed)
      .toEqual({ second: 2 });
  });

  test("resolves an absolute recursive $ref to the isolated root $id", () => {
    const schema = {
      $id: "https://schemas.agenc.test/recursive-node",
      type: "object",
      properties: {
        value: { type: "string" },
        next: {
          anyOf: [
            { $ref: "https://schemas.agenc.test/recursive-node" },
            { type: "null" },
          ],
        },
      },
      required: ["value", "next"],
    };

    expect(parseStructuredOutputValue({
      value: "root",
      next: { value: "child", next: null },
    }, "recursive", schema).parsed).toEqual({
      value: "root",
      next: { value: "child", next: null },
    });
  });

  test.each(["glm-5.3", "glm-5.3-flash"])(
    "uses local-schema-validated json_object mode for Z.ai model %s",
    (model) => {
      expect(
        resolveProviderStructuredOutputMode({
          provider: "zai",
          model,
          api: "chat_completions",
        }),
      ).toBe("chat_json_object");
    },
  );

  test("uses local-schema-validated json_object mode on Z.AI Coding Plan", () => {
    expect(
      resolveProviderStructuredOutputMode({
        provider: "zai-coding-plan",
        model: "glm-5.3",
        api: "chat_completions",
      }),
    ).toBe("chat_json_object");
  });

  test.each([
    [
      "minimum",
      { type: "object", properties: { count: { type: "number", minimum: 2 } } },
      { count: 1 },
    ],
    [
      "pattern",
      { type: "object", properties: { code: { type: "string", pattern: "^[A-Z]+$" } } },
      { code: "lowercase" },
    ],
    [
      "$ref",
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/positive" } },
        $defs: { positive: { type: "integer", minimum: 1 } },
      },
      { value: 0 },
    ],
  ] as const)(
    "fully validates Z.AI json_object output keyword %s locally",
    (_keyword, schema, value) => {
      expect(() => parseStructuredOutputValue(value, "zai_result", schema))
        .toThrow(/violated its JSON schema/i);
    },
  );

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

  test("rejects malformed array-shaped union schema branches", () => {
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
    ).toThrow(/schema is invalid.*anyOf/i);
  });

  test("rejects array-shaped structured payloads as non-object results", () => {
    expect(() =>
      parseStructuredOutputText(JSON.stringify([{ answer: "ok" }]), "answer", SCHEMA),
    ).toThrow(/top-level JSON object/);
  });
});
