import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    vi.stubEnv("CDPATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    expect(targets("cd -P sub && cd -- deeper && rm a").targets).toEqual([join(ROOT, "sub/deeper/a")]);
    // After `;` the next command runs even when the cd failed.
    expect(targets("cd sub; rm a").targets).toEqual([join(ROOT, "sub/a"), join(ROOT, "a")]);
    expect(targets("pushd sub && rm a").targets).toEqual([join(ROOT, "sub/a")]);
    expect(targets("cd && rm x").targets).toEqual([join(homedir(), "x")]);
    expect(targets("bash -c 'cd sub && rm a'").targets).toEqual([join(ROOT, "sub/a")]);
    expect(targets(`cd /tmp && time -p cd ${ROOT}/sub && rm a`).targets).toEqual([join(ROOT, "sub/a")]);
  });

  it("reports the writes of commands after reserved words", () => {
    expect(targets("if true; then touch a.js; fi").targets).toEqual([join(ROOT, "a.js")]);
    expect(targets("! rm old.txt && time -p rm b").targets).toEqual([
      join(ROOT, "old.txt"),
      join(ROOT, "b"),
    ]);
  });

  it("reads the command behind a builtin or a wrapper where the cd left the shell", () => {
    expect(targets("cd sub && nohup rm a && sudo -u www touch b").targets).toEqual([
      join(ROOT, "sub/b"),
      join(ROOT, "sub/a"),
    ]);
  });

  it("reports what find removes, writes and runs", () => {
    expect(targets("find build -name '*.o' -delete").targets).toEqual([join(ROOT, "build")]);
    expect(
      targets("find . -fprint list.txt -exec rm -f stale.log \\;").targets,
    ).toEqual([join(ROOT, "list.txt"), join(ROOT, "stale.log")]);
    const found = targets("find src -name '*.pyc' -exec rm {} +");
    expect(found.targets).toEqual([join(ROOT, "src")]);
    expect(found.indeterminate).toBe(true);
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

  it("marks sh -c code the shell still expands as indeterminate", () => {
    expect(targets("bash -c \"rm a; echo '$X'\"")).toEqual({
      targets: [join(ROOT, "a")],
      indeterminate: true,
    });
    expect(targets("bash -c 'rm a; echo \"$X\"'").indeterminate).toBe(false);
  });

  it("reads the code behind a shell wrapper's options", () => {
    for (const command of ["bash -ec 'rm a'", "bash -c -e 'rm a'", "sh -c -o errexit 'rm a'", "ksh 'rm a'"]) {
      expect(targets(command), command).toEqual({ targets: [join(ROOT, "a")], indeterminate: false });
    }
    expect(targets("bash $F 'rm a'")).toEqual({ targets: [join(ROOT, "a")], indeterminate: true });
  });

  it("reads an argument vector in its working directory", () => {
    expect(collectShellMutationTargets({
      toolName: "system.bash",
      args: { command: "rm", args: ["a.js"], cwd: join(ROOT, "src") },
      workspaceRoot: ROOT,
    }).targets).toEqual([join(ROOT, "src/a.js")]);
  });

  it("reads the code eval runs", () => {
    expect(targets("eval 'rm ../outside.txt'").targets).toEqual(["/work/outside.txt"]);
    expect(targets("eval 'cd sub && rm a'").targets).toEqual([join(ROOT, "sub/a")]);
    expect(targets('eval "$CMD"').indeterminate).toBe(true);
  });

  it("returns nothing for a tool that is not a shell", () => {
    expect(collectShellMutationTargets({
      toolName: "Write",
      args: { command: "rm a" },
      workspaceRoot: ROOT,
    })).toEqual({ targets: [], indeterminate: false });
  });

  it("reads cd the way the workspace write policy does", () => {
    const decision = classifyShellWorkspaceWritePolicy({
      toolName: "exec_command",
      args: { command: "cd sub && rm a" },
      workspaceRoot: ROOT,
      allowWorkspaceDeletions: true,
      platform: "linux",
    });
    expect(decision.observedTargets).toEqual([join(ROOT, "sub/a")]);
  });
});
