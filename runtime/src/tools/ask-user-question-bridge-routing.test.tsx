import { describe, expect, test, vi } from "vitest";

vi.mock("../tui/ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

// branding-scan: allow existing TUI adapter directory name
import {
  createBridgeTool,
  createBridgeTools,
} from "../tui/bridges/tool-stubs.js"; // branding-scan: allow existing TUI adapter directory name
import { AskUserQuestionTool } from "./ask-user-question/tui-tool.js";

describe("AskUserQuestion bridge routing", () => {
  test("uses the AgenC tool object so PermissionRequest selects the structured question UI", () => {
    expect(createBridgeTool("AskUserQuestion")).toBe(AskUserQuestionTool);
    expect(createBridgeTools([])).toContain(AskUserQuestionTool);
  });
});
