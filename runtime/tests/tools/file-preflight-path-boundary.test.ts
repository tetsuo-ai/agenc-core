import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const probe = vi.hoisted(() => ({ calls: [] as { operation: string; path: string }[] }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  function wrap<T extends (...args: never[]) => unknown>(operation: string, fn: T): T {
    return ((path: unknown, ...args: unknown[]) => {
      probe.calls.push({ operation, path: String(path) });
      if (String(path).includes("qv-unapproved-network")) {
        throw Object.assign(new Error("mock unapproved lookup"), { code: "ENOENT" });
      }
      return (fn as Function)(path, ...args);
    }) as T;
  }
  return {
    ...actual,
    realpathSync: Object.assign(wrap("realpath", actual.realpathSync), { native: actual.realpathSync.native }),
    lstatSync: wrap("lstat", actual.lstatSync),
    statSync: wrap("stat", actual.statSync),
    readlinkSync: wrap("readlink", actual.readlinkSync),
  };
});
import { createFileEditTool, createFileMultiEditTool } from "../../src/tools/system/file-edit.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { createApplyPatchTool } from "../../src/tools/apply-patch/tool.js";
import { withSignedAllowedRoots, withSignedSessionId } from "../../src/tools/system/filesystem.js";

let root: string | undefined;
beforeEach(() => { probe.calls = []; });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
function fixture(name: string, path: string, roots = ["/workspace"], cwd = roots[0]!) {
  const tool = name === "Edit" ? createFileEditTool({ allowedPaths: roots })
    : name === "MultiEdit" ? createFileMultiEditTool({ allowedPaths: roots })
    : name === "Write" ? createFileWriteTool({ allowedPaths: roots })
    : createApplyPatchTool({ allowedPaths: roots, cwd });
  const args = name === "apply_patch" ? { input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-a\n+b\n*** End Patch`, cwd }
    : { file_path: path, old_string: "a", new_string: "b", content: "b", edits: [{ old_string: "a", new_string: "b" }], cwd };
  return { tool, args: withSignedSessionId(args, "path-preflight") };
}

describe.each(["Edit", "MultiEdit", "Write", "apply_patch"])("%s preflight lookup boundary", name => {
  test.each([
    String.raw`\\qv-unapproved-network\share\file.txt`,
    "//qv-unapproved-network/share/file.txt",
    String.raw`\\?\UNC\qv-unapproved-network\share\file.txt`,
    "/qv-unapproved-network/file.txt",
    "../qv-unapproved-network/file.txt",
    "/workspace-other/file.txt",
  ])("defers %s without filesystem calls", path => {
    const { tool, args } = fixture(name, path);
    expect(tool.preflight?.(args)).toBeNull();
    expect(probe.calls).toEqual([]);
  });
  test("a network cwd is not resolved even for a relative operand", () => {
    const { tool, args } = fixture(name, "file.txt", ["/workspace"], "//qv-unapproved-network/share");
    expect(tool.preflight?.(args)).toBeNull();
    expect(probe.calls).toEqual([]);
  });
  test("a network workspace root is not inspected", () => {
    const { tool, args } = fixture(name, "file.txt", ["//qv-unapproved-network/share"], "/workspace");
    expect(tool.preflight?.(args)).toBeNull();
    expect(probe.calls).toEqual([]);
  });
  test("injected allowed roots do not grant preflight lookup authority", () => {
    const { tool, args } = fixture(name, "/qv-unapproved-network/file.txt");
    expect(tool.preflight?.(withSignedAllowedRoots(args, ["/qv-unapproved-network"]))).toBeNull();
    expect(probe.calls).toEqual([]);
  });
  test.skipIf(process.platform === "win32")("does not resolve a local symlink to an unapproved share or directory", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agenc-preflight-path-")));
    for (const [index, target] of ["//qv-unapproved-network/share", "/qv-unapproved-network"].entries()) {
      const alias = join(root, `alias${index}`);
      await symlink(target, alias);
      const { tool, args } = fixture(name, join(alias, "file.txt"), [root]);
      probe.calls = [];
      expect(tool.preflight?.(args)).toBeNull();
      expect(probe.calls.some(call => call.path.includes("qv-unapproved-network"))).toBe(false);
      expect(probe.calls.some(call => call.operation === "realpath")).toBe(false);
    }
  });
});
