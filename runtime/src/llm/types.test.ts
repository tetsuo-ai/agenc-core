import { describe, expect, it } from "vitest";
import {
  isAnchorPreserved,
  partitionByAnchorPreserve,
  validateToolCall,
  validateToolCallDetailed,
  type LLMMessage,
} from "./types.js";

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

describe("isAnchorPreserved", () => {
  it("returns true only when runtimeOnly.anchorPreserve === true", () => {
    const yes: LLMMessage = {
      role: "user",
      content: "x",
      runtimeOnly: { anchorPreserve: true },
    };
    const noUndefined: LLMMessage = { role: "user", content: "x" };
    const noExplicitFalse: LLMMessage = {
      role: "user",
      content: "x",
      runtimeOnly: { anchorPreserve: false },
    };
    const noOtherRuntimeOnly: LLMMessage = {
      role: "user",
      content: "x",
      runtimeOnly: { mergeBoundary: "user_context" },
    };
    expect(isAnchorPreserved(yes)).toBe(true);
    expect(isAnchorPreserved(noUndefined)).toBe(false);
    expect(isAnchorPreserved(noExplicitFalse)).toBe(false);
    expect(isAnchorPreserved(noOtherRuntimeOnly)).toBe(false);
  });
});

describe("partitionByAnchorPreserve", () => {
  const mk = (
    id: string,
    preserve: boolean,
  ): LLMMessage => ({
    role: "user",
    content: id,
    ...(preserve
      ? { runtimeOnly: { anchorPreserve: true } }
      : {}),
  });

  it("splits into anchor-preserved and rest, preserving within-subset order", () => {
    const history = [
      mk("a", false),
      mk("b", true),
      mk("c", false),
      mk("d", true),
      mk("e", false),
    ];
    const { anchorPreserved, rest } = partitionByAnchorPreserve(history);
    expect(anchorPreserved.map((m) => m.content)).toEqual(["b", "d"]);
    expect(rest.map((m) => m.content)).toEqual(["a", "c", "e"]);
  });

  it("returns two empty arrays for empty input", () => {
    const { anchorPreserved, rest } = partitionByAnchorPreserve([]);
    expect(anchorPreserved).toEqual([]);
    expect(rest).toEqual([]);
  });

  it("returns all-rest when no message is anchor-preserved", () => {
    const history = [mk("a", false), mk("b", false)];
    const { anchorPreserved, rest } = partitionByAnchorPreserve(history);
    expect(anchorPreserved).toEqual([]);
    expect(rest.map((m) => m.content)).toEqual(["a", "b"]);
  });

  it("returns all-anchor-preserved when every message is marked", () => {
    const history = [mk("a", true), mk("b", true)];
    const { anchorPreserved, rest } = partitionByAnchorPreserve(history);
    expect(anchorPreserved.map((m) => m.content)).toEqual(["a", "b"]);
    expect(rest).toEqual([]);
  });
});
