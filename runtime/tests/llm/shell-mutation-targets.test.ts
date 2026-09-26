import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyShellWorkspaceWritePolicy,
  collectShellMutationTargets,
} from "../../src/llm/shell-write-policy.js";

const ROOT = "/work/tree";

function targets(command: string, cwd = ROOT) {
  return collectShellMutationTargets({
    toolName: "exec_command",
    args: { command, cwd },
    workspaceRoot: ROOT,
    platform: "linux",
  });
}

describe("collectShellMutationTargets", () => {
  it("reports writes, removals and both ends of a move", () => {
    expect(targets("echo x > out.txt; rm old.txt; mv a.js lib/a.js").targets).toEqual([
      join(ROOT, "out.txt"),
      join(ROOT, "old.txt"),
      join(ROOT, "a.js"),
      join(ROOT, "lib/a.js"),
    ]);
  });

  it("resolves each command where an earlier cd left the shell", () => {
    expect(targets("cd sub && echo x > f.txt").targets).toEqual([join(ROOT, "sub/f.txt")]);
    expect(targets("cd ../.. && rm src/a.js").targets).toEqual(["/src/a.js"]);
    expect(targets("cd -P sub; cd -- deeper && rm a").targets).toEqual([join(ROOT, "sub/deeper/a")]);
    expect(targets("pushd sub && rm a").targets).toEqual([join(ROOT, "sub/a")]);
    expect(targets("cd && rm x").targets).toEqual([join(homedir(), "x")]);
    expect(targets("bash -c 'cd sub && rm a'").targets).toEqual([join(ROOT, "sub/a")]);
  });

  it("ends a subshell's cd with the subshell", () => {
    expect(targets("(cd sub && rm a) && rm b").targets).toEqual([join(ROOT, "sub/a"), join(ROOT, "b")]);
  });

  it("marks a change it cannot read as indeterminate", () => {
    for (const command of ['cd "$DIR" && rm a', "cd - && rm a", "popd && rm a", "pushd +1 && rm a"]) {
      expect(targets(command).indeterminate, command).toBe(true);
    }
    expect(targets("cd sub && rm a").indeterminate).toBe(false);
  });

  it("reads an argument vector in its working directory", () => {
    expect(collectShellMutationTargets({
      toolName: "system.bash",
      args: { command: "rm", args: ["a.js"], cwd: join(ROOT, "src") },
      workspaceRoot: ROOT,
    }).targets).toEqual([join(ROOT, "src/a.js")]);
  });

  it("returns nothing for a tool that is not a shell", () => {
    expect(collectShellMutationTargets({
      toolName: "Write",
      args: { command: "rm a" },
      workspaceRoot: ROOT,
    })).toEqual({ targets: [], indeterminate: false });
  });

  it("leaves the workspace write policy's own reading of cd unchanged", () => {
    const decision = classifyShellWorkspaceWritePolicy({
      toolName: "exec_command",
      args: { command: "cd sub && rm a" },
      workspaceRoot: ROOT,
      allowWorkspaceDeletions: true,
      platform: "linux",
    });
    expect(decision.observedTargets).toEqual([join(ROOT, "a")]);
  });
});
