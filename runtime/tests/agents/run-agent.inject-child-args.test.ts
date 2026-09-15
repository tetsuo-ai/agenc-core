import { describe, expect, it } from "vitest";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ID_ARG,
} from "../../src/agents/_deps/filesystem-args.js";
import {
  injectChildToolArgs,
  WORKTREE_CWD_FIELD_BY_TOOL,
} from "../../src/agents/run-agent.js";

const worktree = { path: "/repo/.agenc-worktrees/m5-abc" } as never;
const opts = { childConversationId: "child-1", worktree };

describe("injectChildToolArgs pins the worktree through each tool's own field", () => {
  it("gives exec_command a workdir and never the removed cwd alias", () => {
    const args = injectChildToolArgs({ cmd: "npm test" }, "exec_command", opts);
    expect(args.workdir).toBe(worktree.path);
    expect(Object.hasOwn(args, "cwd")).toBe(false);
    expect(args[SESSION_ID_ARG]).toBe("child-1");
    expect(args[SESSION_ALLOWED_ROOTS_ARG]).toContain(worktree.path);
  });

  it("keeps a working directory the model supplied", () => {
    const args = injectChildToolArgs(
      { cmd: "npm test", workdir: "/repo/.agenc-worktrees/m5-abc/pkg" },
      "exec_command",
      opts,
    );
    expect(args.workdir).toBe("/repo/.agenc-worktrees/m5-abc/pkg");
    expect(Object.hasOwn(args, "cwd")).toBe(false);
  });

  it("pins file and search tools to the child cwd and leaves process listing without a cwd", () => {
    expect(injectChildToolArgs({ command: "ls" }, "system.bash", opts).cwd).toBe(
      worktree.path,
    );
    expect(injectChildToolArgs({ patch: "" }, "apply_patch", opts).cwd).toBe(
      worktree.path,
    );
    for (const toolName of ["FileRead", "Write", "Edit", "MultiEdit", "Glob", "Grep"]) {
      expect(injectChildToolArgs({ path: "x" }, toolName, opts).cwd).toBe(worktree.path);
      expect(injectChildToolArgs({ cwd: "/explicit" }, toolName, opts).cwd).toBe("/explicit");
    }
    const other = injectChildToolArgs({}, "list_processes", opts);
    expect(Object.hasOwn(other, "cwd")).toBe(false);
    expect(Object.hasOwn(other, "workdir")).toBe(false);
    expect(WORKTREE_CWD_FIELD_BY_TOOL).toEqual({
      "system.bash": "cwd",
      exec_command: "workdir",
      apply_patch: "cwd",
      Glob: "cwd", Grep: "cwd", FileRead: "cwd", Write: "cwd", Edit: "cwd", MultiEdit: "cwd",
    });
  });

  it("injects no working directory without a worktree", () => {
    const args = injectChildToolArgs({ cmd: "ls" }, "exec_command", {
      childConversationId: "child-1",
    });
    expect(Object.hasOwn(args, "workdir")).toBe(false);
    expect(Object.hasOwn(args, "cwd")).toBe(false);
  });
});
