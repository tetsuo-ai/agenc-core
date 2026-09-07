import path from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeShellRuntimeAccess } from "../../../src/tools/runtimes/shell.js";
import type { Tool } from "../../../src/tools/types.js";

const shellTool: Tool = {
  name: "exec_command",
  description: "Shell access analysis fixture",
  inputSchema: {},
  execute: async () => ({ content: "" }),
};
const workspaceRoot = path.resolve("shell-lexer-workspace");

describe("shell runtime access analysis", () => {
  it.each([
    'cat "$(touch src/file)"', "cat <(touch src/file)", "cat $\\\n(touch src/file)",
    "cat <<EOF\n$(touch src/file)\nEOF", "cat 'open", "cat <<EOF\nbody",
  ])("does not mark active substitution or malformed input read-only: %s", (command) => {
    const analysis = analyzeShellRuntimeAccess(shellTool, { command }, workspaceRoot);
    expect(analysis?.indeterminateRead).toBe(true);
    expect(analysis?.indeterminateWrite).toBe(true);
    expect(analysis?.knownSafeWhenTargetless).toBe(false);
  });

  it("keeps quoted heredoc contents out of the command stream", () => {
    const command = "cat <<'EOF'\ntouch src/file\n$(literal)\nEOF";
    const analysis = analyzeShellRuntimeAccess(shellTool, { command }, workspaceRoot);
    expect(analysis?.indeterminateRead).toBe(false);
    expect(analysis?.indeterminateWrite).toBe(false);
    expect(analysis?.knownSafeWhenTargetless).toBe(true);
  });

  it("preserves literal separators in read-only command arguments", () => {
    const analysis = analyzeShellRuntimeAccess(shellTool, { command: "cat '|' touch" }, workspaceRoot);
    expect(analysis?.knownSafeWhenTargetless).toBe(true);
    expect(analysis?.writeTargets).toEqual([]);
  });

  it("observes writes after a continued heredoc delimiter", () => {
    const command = "cat <<EOF\nEO\\\nF\ntouch src/file";
    const analysis = analyzeShellRuntimeAccess(shellTool, { command }, workspaceRoot);
    expect(analysis?.writeTargets).toContain(path.join(workspaceRoot, "src/file"));
    expect(analysis?.knownSafeWhenTargetless).toBe(false);
  });
});
