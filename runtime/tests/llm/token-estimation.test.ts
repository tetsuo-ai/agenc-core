import { describe, expect, test } from "vitest";

import {
  bytesPerTokenForFileType,
  detectContentType,
  estimateWithBounds,
  getBytesPerTokenForProvider,
  getTokenizerConfigForProvider,
  roughTokenCountEstimation,
  roughTokenCountEstimationForContent,
  roughTokenCountEstimationForFileType,
  roughTokenCountEstimationForMessages,
  roughTokenCountEstimationForProvider,
} from "./token-estimation.js";

describe("token estimation", () => {
  test("uses UTF-8 bytes and a whole-value ceiling", () => {
    expect(roughTokenCountEstimation("abcd".repeat(10))).toBe(10);
    expect(roughTokenCountEstimation("abcde", 2)).toBe(3);
    expect(roughTokenCountEstimation("x", 4)).toBe(1);
    expect(roughTokenCountEstimation("👩‍💻", 4)).toBeGreaterThan(1);
  });

  test("assigns a nonzero estimate to every nonempty short message", () => {
    const messages = Array.from({ length: 100 }, () => ({
      role: "user",
      content: "x",
    }));

    expect(roughTokenCountEstimationForMessages(messages)).toBeGreaterThanOrEqual(
      messages.length,
    );
  });

  test("uses denser estimates for JSON-like file extensions", () => {
    const content = "x".repeat(80);

    expect(bytesPerTokenForFileType(".json")).toBe(2);
    expect(bytesPerTokenForFileType("jsonc")).toBe(2);
    expect(bytesPerTokenForFileType("txt")).toBe(4);
    expect(roughTokenCountEstimationForFileType(content, ".json")).toBe(40);
    expect(roughTokenCountEstimationForFileType(content, ".txt")).toBe(20);
  });

  test("resolves provider and model family ratios", () => {
    expect(
      getTokenizerConfigForProvider({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      }).modelFamily,
    ).toBe("anthropic");
    expect(getTokenizerConfigForProvider({ provider: "grok" }).modelFamily).toBe(
      "grok",
    );
    expect(getTokenizerConfigForProvider({ model: "deepseek-chat" }).modelFamily)
      .toBe("deepseek");
    expect(getBytesPerTokenForProvider({ provider: "anthropic" })).toBe(3.5);
    expect(
      roughTokenCountEstimationForProvider("a".repeat(35), {
        provider: "anthropic",
      }),
    ).toBe(10);
  });

  test("classifies dense content before estimating bounds", () => {
    expect(detectContentType('{"ok":true}')).toBe("json");
    expect(detectContentType("name,value\nalpha,1\nbeta,2")).toBe("table");
    expect(detectContentType("1. first\n2. second")).toBe("list");
    expect(detectContentType("function x() { return y; }")).toBe("code");
    expect(detectContentType("The panel is 12px wide")).toBe("technical");
    expect(detectContentType("A normal sentence with ordinary words.")).toBe(
      "prose",
    );

    const bounds = estimateWithBounds("x".repeat(200), "code");
    expect(bounds.min).toBeLessThan(bounds.estimate);
    expect(bounds.estimate).toBeLessThan(bounds.max);
  });

  test("estimates multimodal blocks from their actual serialized payload", () => {
    const shortPayload = roughTokenCountEstimationForContent([
      { type: "text", text: "a".repeat(8) },
      { type: "image", source: { data: "a" } },
      { type: "document", source: { data: "b" } },
    ]);
    const longPayload = roughTokenCountEstimationForContent([
      { type: "text", text: "a".repeat(8) },
      { type: "image", source: { data: "a".repeat(400) } },
      { type: "document", source: { data: "b".repeat(400) } },
    ]);

    expect(shortPayload).toBeGreaterThan(0);
    expect(longPayload).toBeGreaterThan(shortPayload);

    expect(
      roughTokenCountEstimationForContent({
        type: "tool_use",
        name: "Read",
        input: { file_path: "/tmp/a.ts" },
      }),
    ).toBeGreaterThan(5);
  });

  test("estimates runtime-style messages with provider hints", () => {
    expect(
      roughTokenCountEstimationForMessages(
        [
          {
            role: "assistant",
            message: { content: "a".repeat(35) },
          },
          {
            role: "tool",
            content: { type: "tool_result", content: "b".repeat(14) },
          },
        ],
        { provider: "anthropic" },
      ),
    ).toBe(14);
  });
});
