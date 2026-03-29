import { describe, expect, it } from "vitest";
import { validateToolCall, validateToolCallDetailed } from "./types.js";

describe("validateToolCall", () => {
  it("accepts a valid tool call payload", () => {
    const result = validateToolCall({
      id: "call_1",
      name: "lookup",
      arguments: '{"q":"hello"}',
    });

    expect(result).toEqual({
      id: "call_1",
      name: "lookup",
      arguments: '{"q":"hello"}',
    });
  });

  it("rejects missing ids", () => {
    expect(
      validateToolCall({
        name: "lookup",
        arguments: "{}",
      }),
    ).toBeNull();
  });

  it("rejects empty names", () => {
    expect(
      validateToolCall({
        id: "call_1",
        name: "",
        arguments: "{}",
      }),
    ).toBeNull();
  });

  it("rejects non-JSON argument strings", () => {
    expect(
      validateToolCall({
        id: "call_1",
        name: "lookup",
        arguments: "{bad-json",
      }),
    ).toBeNull();
  });

  it("preserves valid JSON structure before decoding HTML entities in string values", () => {
    const result = validateToolCall({
      id: "call_1",
      name: "system.writeFile",
      arguments:
        '{"path":"src/parser.c","content":"strcmp(token, \\"&quot;&gt;&quot;\\") == 0 && strcmp(token, \\"&amp;\\") == 0;"}',
    });

    expect(result).toEqual({
      id: "call_1",
      name: "system.writeFile",
      arguments:
        '{"path":"src/parser.c","content":"strcmp(token, \\"\\">\\"\\") == 0 && strcmp(token, \\"&\\") == 0;"}',
    });
  });

  it("falls back to decoding the raw JSON text only when the original JSON is invalid", () => {
    const result = validateToolCall({
      id: "call_1",
      name: "lookup",
      arguments: '{&quot;q&quot;:&quot;hello&quot;}',
    });

    expect(result).toEqual({
      id: "call_1",
      name: "lookup",
      arguments: '{"q":"hello"}',
    });
  });

  it("returns a structured failure reason for rejected tool calls", () => {
    const result = validateToolCallDetailed({
      id: "call_1",
      name: "lookup",
      arguments: '["bad"]',
    });

    expect(result.toolCall).toBeNull();
    expect(result.failure).toEqual({
      code: "non_object_arguments",
      message: "Tool call arguments must decode to a JSON object.",
    });
  });
});
