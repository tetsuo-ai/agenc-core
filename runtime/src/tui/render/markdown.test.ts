import { describe, expect, it } from "vitest";

import {
  createMarkdownDisplayLineStream,
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
    expect(
      lines.some(
        (line) =>
          line.mode === "code" && line.plainText.includes("const answer = 42;"),
      ),
    ).toBe(true);
  });

  it("renders streaming markdown previews with the same display-line shape", () => {
    const lines = renderStreamingMarkdownDisplayLinesSync("# Heading\n\nhello");
    expect(lines[0]?.mode).toBe("heading");
    expect(lines.at(-1)?.plainText).toContain("hello");
  });

  it("commits complete streaming lines without re-rendering the settled prefix", () => {
    const stream = createMarkdownDisplayLineStream({ width: 80 });
    stream.syncToValue("# Heading");
    expect(stream.commitCompleteLines()).toEqual([]);
    expect(stream.previewPendingLines()[0]?.plainText).toContain("Heading");

    stream.syncToValue("# Heading\n\nhello");
    const committed = stream.commitCompleteLines();
    expect(committed[0]?.mode).toBe("heading");
    expect(committed[0]?.plainText).toContain("Heading");
    const preview = stream.previewPendingLines();
    expect(preview.at(-1)?.plainText).toContain("hello");
  });
});
