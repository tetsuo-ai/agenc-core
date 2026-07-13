import { describe, expect, test } from "vitest";

import { parseOpenAIResponsesResponse } from "../../../src/llm/wire/responses-openai.js";

// M-LLM-2 (core-todo.md): parseOpenAIResponsesResponse parsed structured output
// whenever a schema + non-empty content were present, WITHOUT checking whether the
// generation completed. A truncated reply (status 'incomplete', reason
// max_output_tokens -> finishReason 'length') holds partial JSON; the parser then
// JSON.parsed it and threw "invalid JSON instead of a schema object", failing the
// whole turn instead of surfacing the recoverable truncation. The chat-completions
// path already guards this with generationCompleted (gaphunt3 #20); this pins the
// Responses path to the same behavior.

const structuredRequest = {
  model: "gpt-5",
  messages: [{ role: "user" as const, content: "give me the answer object" }],
  tools: [],
  options: {
    structuredOutput: {
      schema: {
        type: "json_schema" as const,
        name: "answer",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    },
  },
};

function truncatedResponse(partialJson: string) {
  return {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: partialJson }],
      },
    ],
  };
}

describe("parseOpenAIResponsesResponse — M-LLM-2 truncated structured output", () => {
  test("a truncated reply with partial JSON does not throw and yields no structured output", () => {
    let response!: ReturnType<typeof parseOpenAIResponsesResponse>;
    expect(() => {
      // Unterminated JSON — JSON.parse would throw if we attempted to parse it.
      response = parseOpenAIResponsesResponse(
        "gpt-5",
        truncatedResponse('{"answer":"partial ans'),
        structuredRequest,
      );
    }).not.toThrow();
    expect(response.finishReason).toBe("length");
    expect(response.structuredOutput).toBeUndefined();
  });

  test("a completed reply with valid JSON still parses structured output", () => {
    const response = parseOpenAIResponsesResponse(
      "gpt-5",
      {
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: '{"answer":"ok"}' }] },
        ],
      },
      structuredRequest,
    );
    expect(response.structuredOutput).toMatchObject({
      name: "answer",
      parsed: { answer: "ok" },
    });
  });
});
