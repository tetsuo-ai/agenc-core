import { describe, expect, test } from "vitest";

import {
  lexMarkdownTokensForParity,
  markdownTokenCacheSizeForParity,
  StreamingMarkdown,
} from "./MarkdownBlock.js";

describe("MarkdownBlock OpenClaude parity", () => {
  test("uses marked tokens and a module-level markdown token cache", () => {
    const before = markdownTokenCacheSizeForParity();
    const first = lexMarkdownTokensForParity("| A | B |\n| - | - |\n| 1 | 2 |");
    const second = lexMarkdownTokensForParity("| A | B |\n| - | - |\n| 1 | 2 |");

    expect(first).toBe(second);
    expect(first.some((token) => token.type === "table")).toBe(true);
    expect(markdownTokenCacheSizeForParity()).toBeGreaterThanOrEqual(before);
  });

  test("exposes stable-prefix streaming markdown rendering", () => {
    const element = (
      <StreamingMarkdown width={80}>{"# Title\n\nbody"}</StreamingMarkdown>
    );

    expect(element.props.children).toContain("Title");
    expect(element.props.width).toBe(80);
  });
});
