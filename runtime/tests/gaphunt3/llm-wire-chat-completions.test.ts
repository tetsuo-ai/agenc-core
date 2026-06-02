import { describe, expect, it } from "vitest";
import { parseChatCompletionsResponse } from "src/llm/wire/chat-completions.js";
import type { ChatCompletionsRequestOptions } from "src/llm/wire/chat-completions.js";

// gaphunt3 #20: when a structured-output generation is truncated
// (finish_reason 'length' / incomplete), the assistant `content` holds
// partial, invalid JSON. parseChatCompletionsResponse must NOT call
// parseStructuredOutputText (which JSON.parses and throws) in that case —
// it must return finishReason:'length' with structuredOutput undefined so
// the runtime surfaces a recoverable truncation instead of a hard error.
describe("gaphunt3 #20 parseChatCompletionsResponse: truncated structured output", () => {
  const requestWithSchema: ChatCompletionsRequestOptions = {
    model: "gpt-4.1",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    options: {
      structuredOutput: {
        schema: {
          type: "json_schema",
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

  it("does not throw on truncated (finish_reason 'length') partial JSON", () => {
    const partialJson = '{"answer":"this got cut off';

    let response: ReturnType<typeof parseChatCompletionsResponse> | undefined;
    expect(() => {
      response = parseChatCompletionsResponse(
        "gpt-4.1",
        {
          id: "chatcmpl_truncated",
          choices: [
            {
              message: { role: "assistant", content: partialJson },
              finish_reason: "length",
            },
          ],
        },
        requestWithSchema,
      );
    }).not.toThrow();

    expect(response).toBeDefined();
    expect(response!.finishReason).toBe("length");
    // Partial JSON must not be parsed; structuredOutput stays undefined.
    expect(response!.structuredOutput).toBeUndefined();
    // Raw partial content is still surfaced for inspection.
    expect(response!.content).toBe(partialJson);
  });

  it("does not parse structured output on a content_filter/error truncation either", () => {
    const partialJson = '{"answer":';

    const response = parseChatCompletionsResponse(
      "gpt-4.1",
      {
        id: "chatcmpl_filtered",
        choices: [
          {
            message: { role: "assistant", content: partialJson },
            finish_reason: "content_filter",
          },
        ],
      },
      requestWithSchema,
    );

    expect(response.finishReason).toBe("content_filter");
    expect(response.structuredOutput).toBeUndefined();
  });

  it("still parses structured output on a normal (finish_reason 'stop') completion", () => {
    const completeJson = '{"answer":"ok"}';

    const response = parseChatCompletionsResponse(
      "gpt-4.1",
      {
        id: "chatcmpl_complete",
        choices: [
          {
            message: { role: "assistant", content: completeJson },
            finish_reason: "stop",
          },
        ],
      },
      requestWithSchema,
    );

    expect(response.finishReason).toBe("stop");
    expect(response.structuredOutput).toEqual({
      type: "json_schema",
      name: "answer",
      rawText: completeJson,
      parsed: { answer: "ok" },
    });
  });
});
