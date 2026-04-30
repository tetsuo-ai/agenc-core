import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("OpenClaude markdown rendering parity", () => {
  test("Markdown keeps the marked-token cache and table renderer pipeline", () => {
    const markdown = source("Markdown.tsx");

    expect(markdown).toMatch(/marked\.lexer/u);
    expect(markdown).toMatch(/tokenCache/u);
    expect(markdown).toMatch(/MarkdownTable/u);
    expect(markdown).toMatch(/syntaxHighlightingDisabled/u);
    expect(markdown).toMatch(/stripPromptXMLTags/u);
  });
});
