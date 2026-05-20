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

import { createTuiTool, ToolErrorView } from "./tool-rendering.js";

describe("TUI dynamic tool fallback coverage", () => {
  test("dynamic tools expose the baseline TUI tool contract", async () => {
    const input = { path: "src/example.ts" };
    const tool = createTuiTool("DynamicCoverageTool");

    expect(tool.name).toBe("DynamicCoverageTool");
    expect(tool.aliases).toEqual([]);
    expect(tool.maxResultSizeChars).toBe(Infinity);
    expect(tool.inputSchema.safeParse("raw input")).toEqual({
      success: true,
      data: { value: "raw input" },
    });
    await expect(tool.call(input)).resolves.toEqual({ result: undefined });
    await expect(tool.description()).resolves.toBe("DynamicCoverageTool");
    await expect(tool.prompt()).resolves.toBe(
      "DynamicCoverageTool is provided by the AgenC runtime.",
    );
    await expect(tool.checkPermissions(input)).resolves.toEqual({
      behavior: "ask",
      message: "Permission required to use DynamicCoverageTool",
    });

    expect(tool.isConcurrencySafe(input)).toBe(false);
    expect(tool.isEnabled()).toBe(true);
    expect(tool.isReadOnly(input)).toBe(false);
    expect(tool.isDestructive(input)).toBe(false);
    expect(tool.toAutoClassifierInput(input)).toBe(input);
    expect(tool.userFacingName(input)).toBe("DynamicCoverageTool");
    expect(tool.getActivityDescription(input)).toBe(
      "DynamicCoverageTool {\"path\":\"src/example.ts\"}",
    );
    expect(tool.renderToolUseMessage(input)).toBe(
      "{\"path\":\"src/example.ts\"}",
    );

    const resultBlock = tool.mapToolResultToToolResultBlockParam(
      { content: "result text" },
      "tool-1",
    );
    expect(resultBlock).toEqual({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "result text",
    });

    const errorNode = tool.renderToolUseErrorMessage(new Error("failed"));
    expect((errorNode as { readonly type: unknown }).type).toBe(ToolErrorView);
    expect(
      (errorNode as { readonly props: { readonly content: string } }).props
        .content,
    ).toContain("<tool-error>failed</tool-error>");
  });
});
