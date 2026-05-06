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

import {
  createTuiTool,
  createTuiTools,
} from "../tui/tool-rendering.js";
import { AskUserQuestionTool } from "./ask-user-question/tui-tool.js";

describe("AskUserQuestion TUI routing", () => {
  test("uses the AgenC tool object so PermissionRequest selects the structured question UI", () => {
    expect(createTuiTool("AskUserQuestion")).toBe(AskUserQuestionTool);
    expect(createTuiTools([])).toContain(AskUserQuestionTool);
  });
});
