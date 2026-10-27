import { describe, expect, it, vi } from "vitest";

// Model an existing directory and a protected symlink to it entirely in
// memory. These tests neither create fixtures nor execute the write commands.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: vi.fn((name: unknown) => {
      if (name === "/repo/dist" || name === "/repo/dist/.bashrc") return { isDirectory: () => true };
      throw new Error("missing virtual path");
    }),
    lstatSync: vi.fn((name: unknown) => {
      if (name === "/repo/dist") return { isDirectory: () => true, isSymbolicLink: () => false };
      if (name === "/repo/dist/.bashrc") return { isDirectory: () => false, isSymbolicLink: () => true };
      throw new Error("missing virtual path");
    }),
  };
});

import { classifyShellWorkspaceWritePolicy } from "../../src/llm/shell-write-policy.js";
import { parseWriteCommandOperands } from "../../src/utils/shell/write-command-options.js";

function classify(command: string, args: readonly string[], platform: NodeJS.Platform = "linux") {
  return classifyShellWorkspaceWritePolicy({
    toolName: "exec_command", args: { command, args }, workspaceRoot: "/repo",
    platform, allowWorkspaceDeletions: true, bypassesApprovalsAndSandbox: true,
  });
}

describe("write option destination roles", () => {
  it.each(["cp", "mv", "ln", "install"])("finds %s destinations in existing directories and with -T", command => {
    const ordinary = classify(command, ["tmp/payload", "dist"]);
    expect(ordinary.observedTargets).toContain("/repo/dist/payload");
    expect(ordinary.blocked).toBe(false);
    for (const flag of ["-T", "--no-target", "--no-target-directory"]) {
      const result = classify(command, [flag, "tmp/payload", "dist"]);
      expect(result.observedTargets).toContain("/repo/dist");
      expect(result.observedTargets).not.toContain("/repo/dist/payload");
      expect(result.blocked).toBe(false);
    }
  });

  it.each(["-sn", "-ns", "--no-dereference"])("treats a destination link as a file with ln %s", flag => {
    const result = classify("ln", [flag, "tmp/payload", "dist/.bashrc"]);
    expect(result.indeterminate).toBe(false);
    expect(result.observedTargets).toEqual(["/repo/dist/.bashrc"]);
    expect(result.blockedTargets).toEqual(["/repo/dist/.bashrc"]);
  });

  it("classifies the differing BSD mv and ln -h readings conservatively", () => {
    for (const command of ["mv", "ln"] as const) {
      expect(parseWriteCommandOperands(command, ["-h", "tmp/payload", "dist/.bashrc"], ["bsd"]).noDereferenceDestination).toBe(true);
      const result = classify(command, ["-h", "tmp/payload", "dist/.bashrc"], "darwin");
      expect(result.indeterminate).toBe(true);
      expect(result.observedTargets).toContain("/repo/dist/.bashrc");
      expect(result.blocked).toBe(true);
    }
  });

  it.each(["-sF", "-Fs"])("keeps a directory BSD ln %s could replace", flag => {
    expect(parseWriteCommandOperands("ln", [flag, "tmp/payload", "dist/.bashrc"], ["bsd"]).indeterminate).toBe(true);
    const result = classify("ln", [flag, "tmp/payload", "dist/.bashrc"], "darwin");
    expect(result.observedTargets).toContain("/repo/dist/.bashrc");
    expect(result.blocked).toBe(true);
  });
});
