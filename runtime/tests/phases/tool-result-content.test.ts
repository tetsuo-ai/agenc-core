import { describe, expect, test } from "vitest";

import { toolResultContent } from "../../src/phases/execute-tools.js";
import type { ToolDispatchResult } from "../../src/tool-registry.js";

function result(
  content: string,
  contentItems?: ToolDispatchResult["contentItems"],
): ToolDispatchResult {
  return contentItems === undefined ? { content } : { content, contentItems };
}

describe("toolResultContent", () => {
  test("returns the raw content when contentItems is absent or empty", () => {
    const plain = result("raw text");
    expect(toolResultContent(plain)).toBe("raw text");
    expect(toolResultContent(plain)).toBe(plain.content);

    const empty = result("fallback", []);
    expect(toolResultContent(empty)).toBe("fallback");
  });

  test("maps input_text and input_image items into model-facing parts", () => {
    expect(
      toolResultContent(
        result("ignored", [
          { type: "input_text", text: "hello" },
          { type: "input_image", image_url: "https://example.test/a.png" },
        ]),
      ),
    ).toEqual([
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "https://example.test/a.png" } },
    ]);
  });

  test("coerces missing text and image_url fields instead of dropping the part", () => {
    expect(
      toolResultContent(
        result("ignored", [
          { type: "input_text" } as never,
          { type: "input_image" } as never,
        ]),
      ),
    ).toEqual([
      { type: "text", text: "" },
      { type: "image_url", image_url: { url: "" } },
    ]);
  });

  test("falls back to raw content when every item has an unknown type", () => {
    const fallback = result("keep-me", [
      { type: "input_file", text: "nope" } as never,
      null as never,
      "plain" as never,
    ]);
    expect(toolResultContent(fallback)).toBe("keep-me");
  });
});
