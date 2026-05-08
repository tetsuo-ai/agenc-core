// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const { extractFirstPrompt, sanitizeFilename } = await import("./export.js");

describe("sanitizeFilename", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(sanitizeFilename("Fix Login Bug")).toBe("fix-login-bug");
  });

  it("strips characters that aren't [a-z0-9 -]", () => {
    expect(sanitizeFilename("Update API: v2.0!")).toBe("update-api-v20");
  });

  it("collapses runs of hyphens to one", () => {
    expect(sanitizeFilename("a   b   c")).toBe("a-b-c");
    expect(sanitizeFilename("foo--bar---baz")).toBe("foo-bar-baz");
  });

  it("trims leading and trailing hyphens", () => {
    expect(sanitizeFilename("---hello---")).toBe("hello");
  });

  it("returns empty string when input has no allowed characters", () => {
    expect(sanitizeFilename("!!!@@@###")).toBe("");
  });
});

describe("extractFirstPrompt", () => {
  it("returns empty when there are no user messages", () => {
    expect(extractFirstPrompt([])).toBe("");
    expect(extractFirstPrompt([{ type: "assistant" } as never])).toBe("");
  });

  it("extracts plain string content from the first user message", () => {
    const messages = [
      { type: "user", message: { content: "  Hello there  " } },
      { type: "user", message: { content: "second message" } },
    ];
    expect(extractFirstPrompt(messages as never)).toBe("Hello there");
  });

  it("extracts the first text block from array content", () => {
    const messages = [
      {
        type: "user",
        message: {
          content: [
            { type: "image", source: {} },
            { type: "text", text: "the actual prompt" },
          ],
        },
      },
    ];
    expect(extractFirstPrompt(messages as never)).toBe("the actual prompt");
  });

  it("takes only the first line of multi-line input", () => {
    const messages = [
      { type: "user", message: { content: "first line\nsecond line\nthird" } },
    ];
    expect(extractFirstPrompt(messages as never)).toBe("first line");
  });

  it("truncates input over 50 characters with an ellipsis", () => {
    const long = "x".repeat(80);
    const result = extractFirstPrompt([
      { type: "user", message: { content: long } } as never,
    ]);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith("…")).toBe(true);
  });
});
