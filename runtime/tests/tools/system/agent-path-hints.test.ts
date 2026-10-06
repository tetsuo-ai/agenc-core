import { describe, expect, test } from "vitest";

import {
  FILE_TOOL_PATH_SCHEMA,
  FILE_TOOL_PATH_USAGE,
  formatToolPathForDisplay,
  workspaceRelativeToolPath,
} from "../../../src/tools/system/agent-path-hints.js";

describe("file-tool path copy", () => {
  test("does not tell the model that /root cannot be a filesystem path", () => {
    expect(FILE_TOOL_PATH_USAGE).toContain("filesystem paths");
    expect(FILE_TOOL_PATH_USAGE).not.toMatch(/not the filesystem/i);
    expect(FILE_TOOL_PATH_SCHEMA).toContain("valid Linux filesystem path");
    expect(FILE_TOOL_PATH_SCHEMA).not.toMatch(/Do not use \/root/i);
  });

  test("TUI display does not relabel /root paths as agent namespace", () => {
    expect(formatToolPathForDisplay("/root/data/training_examples.json")).toBe(
      "/root/data/training_examples.json",
    );
    expect(formatToolPathForDisplay("/rooted/data/input.json")).toBe(
      "/rooted/data/input.json",
    );
    expect(formatToolPathForDisplay("game.py")).toBe("game.py");
  });
});

 test("Light shortens only in-workspace absolute display paths", () => {
  expect(workspaceRelativeToolPath("/project/src/a.ts", "/project", true)).toBe("src/a.ts");
  expect(workspaceRelativeToolPath("/project/src/a.ts", "/project", false)).toBe("/project/src/a.ts");
  expect(workspaceRelativeToolPath("/elsewhere/a.ts", "/project", true)).toBe("/elsewhere/a.ts");
  expect(workspaceRelativeToolPath("src/a.ts", "/project", true)).toBe("src/a.ts");
});
