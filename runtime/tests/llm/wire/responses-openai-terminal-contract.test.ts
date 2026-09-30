import { describe, expect, test } from "vitest";
import { parseOpenAIResponsesResponse } from "../../../src/llm/wire/responses-openai.js";

const request = {
  model: "gpt-6-luna",
  messages: [{ role: "user" as const, content: "Synthetic terminal-status check." }],
  tools: [{ type: "function" as const, function: { name: "Write", description: "Write a file",
    parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } } }],
};
const output = (args: string) => [{ type: "function_call", call_id: "synthetic-call",
  name: "Write", arguments: args }];

describe("Responses terminal status controls executable calls", () => {
  test.each([
    ["max_output_tokens", "length"],
    ["content_filter", "content_filter"],
    ["error", "error"],
    ["unknown", "error"],
    ["", "error"],
  ] as const)("incomplete %s cannot produce executable calls even with complete JSON", (reason, expected) => {
    const result = parseOpenAIResponsesResponse("gpt-6-luna", {
      status: "incomplete", incomplete_details: { reason }, output: output('{"content":"synthetic"}'),
    }, request);
    expect(result.finishReason).toBe(expected);
    expect(result.toolCalls).toEqual([]);
  });

  test.each(["max_output_tokens", "content_filter", "error"])(
    "incomplete %s is handled before malformed arguments are parsed", reason => {
      const result = parseOpenAIResponsesResponse("gpt-6-luna", {
        status: "incomplete", incomplete_details: { reason }, output: output('{"content":"unfinished'),
      }, request);
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).not.toBe("tool_calls");
    },
  );

  test("completed valid tool output stays executable", () => {
    const result = parseOpenAIResponsesResponse("gpt-6-luna", {
      status: "completed", output: output('{"content":"synthetic"}'),
    }, request);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([{ id: "synthetic-call", name: "Write", arguments: '{"content":"synthetic"}' }]);
  });

  test.each([undefined, "failed", "cancelled", "expired", "queued", "in_progress", "unknown",
    ["completed"], {}, 1, true, null].map(status => ({ status })))(
    "non-success status $status refuses calls and preserves text/usage", ({ status }) => {
      const result = parseOpenAIResponsesResponse("gpt-6-luna", {
        status, output: [...output('{"content":"synthetic"}'),
          { type: "message", content: [{ type: "output_text", text: "Partial." }] }],
        usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
      }, request);
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).toBe("error");
      expect(result.content).toBe("Partial.");
      expect(result.usage).toMatchObject({ promptTokens: 3, completionTokens: 7, totalTokens: 10 });
    },
  );
});
