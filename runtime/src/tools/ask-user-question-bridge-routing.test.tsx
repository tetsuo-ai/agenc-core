import { describe, expect, test, vi } from "vitest";

vi.mock("../agenc/upstream/ink.js", () => {
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
} from "../tui/openclaude/tool-stubs.js"; // branding-scan: allow existing TUI adapter directory name
import { AskUserQuestionTool as UpstreamAskUserQuestionTool } from "../agenc/upstream/tools/AskUserQuestionTool/AskUserQuestionTool.js";

describe("AskUserQuestion bridge routing", () => {
  test("uses the upstream tool object so PermissionRequest selects the structured question UI", () => {
    expect(createBridgeTool("AskUserQuestion")).toBe(UpstreamAskUserQuestionTool);
    expect(createBridgeTools([])).toContain(UpstreamAskUserQuestionTool);
  });
});
