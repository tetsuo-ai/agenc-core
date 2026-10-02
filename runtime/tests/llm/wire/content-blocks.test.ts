/**
 * Content-block extractors used by Chat Completions, OpenAI Responses, and
 * the OpenAI-compatible stream adapter. Mistral (and any provider that sets
 * `usesThinkingContentBlocks`) splits assistant prose from ThinkChunk arrays
 * here; a misshapen block must not leak into the other channel.
 */
import { describe, expect, test } from "vitest";

import {
  assistantTextFromContentBlocks,
  thinkingTextFromContentBlocks,
} from "./shared.js";

describe("assistantTextFromContentBlocks", () => {
  test("joins output_text and text string pieces with no separator", () => {
    expect(
      assistantTextFromContentBlocks([
        { type: "output_text", text: "Hello" },
        { type: "text", text: " world" },
      ]),
    ).toBe("Hello world");
  });

  test("reads OpenAI Responses nested output_text.value", () => {
    expect(
      assistantTextFromContentBlocks([
        { type: "output_text", text: { value: "nested" } },
      ]),
    ).toBe("nested");
  });

  test("does not treat a nested value on type text as assistant prose", () => {
    expect(
      assistantTextFromContentBlocks([
        { type: "text", text: { value: "ignored" } },
      ]),
    ).toBe("");
  });

  test("skips non-objects, unknown types, and non-string payloads", () => {
    expect(
      assistantTextFromContentBlocks([
        null,
        undefined,
        "plain",
        12,
        { type: "output_text", text: 7 },
        { type: "output_text", text: { value: 1 } },
        { type: "text", text: ["no"] },
        { type: "image_url", image_url: { url: "https://example.invalid/x.png" } },
        { type: "output_text", text: "kept" },
      ]),
    ).toBe("kept");
  });

  test("returns empty for an empty or fully skipped batch", () => {
    expect(assistantTextFromContentBlocks([])).toBe("");
    expect(assistantTextFromContentBlocks([{}, { type: "thinking" }])).toBe("");
  });
});

describe("thinkingTextFromContentBlocks", () => {
  test("extracts Mistral ThinkChunk text arrays", () => {
    expect(
      thinkingTextFromContentBlocks([
        {
          type: "thinking",
          thinking: [{ type: "text", text: "plan A" }],
        },
      ]),
    ).toBe("plan A");
  });

  test("joins multiple thinking blocks and nested output_text chunks", () => {
    expect(
      thinkingTextFromContentBlocks([
        {
          type: "thinking",
          thinking: [
            { type: "text", text: "first" },
            { type: "output_text", text: { value: " second" } },
          ],
        },
        { type: "text", text: "visible" },
        {
          type: "thinking",
          thinking: [{ type: "text", text: " third" }],
        },
      ]),
    ).toBe("first second third");
  });

  test("ignores thinking payloads that are not arrays", () => {
    expect(
      thinkingTextFromContentBlocks([
        { type: "thinking", thinking: "raw" },
        { type: "thinking", thinking: { type: "text", text: "object" } },
        { type: "thinking" },
        null,
        { type: "text", text: "not thinking" },
      ]),
    ).toBe("");
  });

  test("does not treat top-level assistant text as reasoning", () => {
    expect(
      thinkingTextFromContentBlocks([
        { type: "output_text", text: "answer" },
        { type: "text", text: "also answer" },
      ]),
    ).toBe("");
  });
});
