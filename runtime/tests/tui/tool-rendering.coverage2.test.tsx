import { describe, expect, test, vi } from "vitest";

vi.mock("./ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

import { createTuiTool } from "./tool-rendering.js";

describe("TUI Skill tool rendering coverage", () => {
  test("Skill tool cards parse nested JSON input and omit null args from the preview", () => {
    const tool = createTuiTool("Skill");
    const longPrompt = "x".repeat(100);
    const input = {
      skill: JSON.stringify({
        skill: "//$$review-helper",
        args: JSON.stringify({
          file: "runtime/src/tui/tool-rendering.tsx",
          mode: null,
          prompt: longPrompt,
        }),
      }),
    };

    const expectedPreviewPrefix =
      `file runtime/src/tui/tool-rendering.tsx, prompt ${"x".repeat(71)}`;
    const preview = tool.renderToolUseMessage(input);
    const activity = tool.getActivityDescription(input);

    expect(tool.userFacingName(input)).toBe("$review-helper");
    expect(preview.startsWith(expectedPreviewPrefix)).toBe(true);
    expect(preview).toHaveLength(expectedPreviewPrefix.length + 1);
    expect(preview.codePointAt(preview.length - 1)).toBe(0x2026);
    expect(activity).toBe(`Load $review-helper: ${preview}`);
    expect(preview).not.toContain("mode");
    expect(preview).not.toContain(longPrompt);
  });
});
