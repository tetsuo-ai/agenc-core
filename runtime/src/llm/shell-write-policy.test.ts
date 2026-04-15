import { describe, expect, it } from "vitest";

import { evaluateShellWorkspaceWritePolicy } from "./shell-write-policy.js";

describe("evaluateShellWorkspaceWritePolicy", () => {
  const workspaceRoot = "/workspace";

  it("blocks shell heredoc writes into workspace source paths", () => {
    const decision = evaluateShellWorkspaceWritePolicy({
      toolName: "system.bash",
      args: {
        command: "cat <<'EOF' > src/alias.c\nint main(void) { return 0; }\nEOF",
      },
      workspaceRoot,
      turnClass: "workflow_implementation",
    });

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toContain("/workspace/src/alias.c");
    expect(decision.message).toContain("shell_workspace_file_write_disallowed");
  });

  it("allows shell writes under generated output roots", () => {
    const decision = evaluateShellWorkspaceWritePolicy({
      toolName: "system.bash",
      args: {
        command: "make > build/build.log 2>&1",
      },
      workspaceRoot,
      turnClass: "workflow_implementation",
    });

    expect(decision.blocked).toBe(false);
    expect(decision.observedTargets).toContain("/workspace/build/build.log");
  });

  it("allows mkdir scaffolding in workspace source paths", () => {
    const decision = evaluateShellWorkspaceWritePolicy({
      toolName: "system.bash",
      args: {
        command: "mkdir -p src/app include/agenc docs",
      },
      workspaceRoot,
      turnClass: "workflow_implementation",
    });

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
    expect(decision.blockedTargets).toEqual([]);
  });

  it("blocks direct-mode tee writes into workspace source paths", () => {
    const decision = evaluateShellWorkspaceWritePolicy({
      toolName: "system.bash",
      args: {
        command: "tee",
        args: ["src/parser.c"],
      },
      workspaceRoot,
      turnClass: "workflow_implementation",
    });

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual(["/workspace/src/parser.c"]);
  });
});
