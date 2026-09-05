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

  it("uses cwd for system.bash and apply_patch, and touches nothing else", () => {
    expect(injectChildToolArgs({ command: "ls" }, "system.bash", opts).cwd).toBe(
      worktree.path,
    );
    expect(injectChildToolArgs({ patch: "" }, "apply_patch", opts).cwd).toBe(
      worktree.path,
    );
    const other = injectChildToolArgs({ path: "x" }, "FileRead", opts);
    expect(Object.hasOwn(other, "cwd")).toBe(false);
    expect(Object.hasOwn(other, "workdir")).toBe(false);
    expect(WORKTREE_CWD_FIELD_BY_TOOL).toEqual({
      "system.bash": "cwd",
      exec_command: "workdir",
      apply_patch: "cwd",
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
