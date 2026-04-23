import { describe, expect, it } from "vitest";

import {
  renderMarkdownDisplayLines,
  renderMarkdownDisplayLinesSync,
  renderStreamingMarkdownDisplayLinesSync,
} from "./markdown.js";

describe("tui/render/markdown", () => {
  it("renders fenced diff blocks through the shared diff display path", () => {
    const lines = renderMarkdownDisplayLinesSync(
      "```diff\n--- a/file.txt\n+++ b/file.txt\n@@\n-old\n+new\n```",
      { cwd: "/tmp/demo" },
    );

    expect(lines.some((line) => line.mode === "diff-header")).toBe(true);
    expect(lines.some((line) => line.mode === "diff-add")).toBe(true);
  });

  it("highlights fenced code blocks when highlighting is enabled", async () => {
    const lines = await renderMarkdownDisplayLines(
      "```ts\nconst answer = 42;\n```",
      { width: 80 },
    );

    expect(lines[0]?.mode).toBe("code-meta");
    expect(lines.some((line) => line.mode === "code" && line.text.includes("\u001b["))).toBe(true);
  });

  it("renders streaming markdown previews with the same display-line shape", () => {
    const lines = renderStreamingMarkdownDisplayLinesSync("# Heading\n\nhello");
    expect(lines[0]?.mode).toBe("heading");
    expect(lines.at(-1)?.plainText).toContain("hello");
  });
});
