import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createApplyPatchTool,
  type ApplyPatchRunner,
} from "./apply-patch.js";

describe("apply_patch tool", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-apply-patch-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("validates Codex patch targets before invoking the runner", async () => {
    const runner = vi.fn<ApplyPatchRunner>(async () => ({
      stdout: "Success. Updated the following files:\nA new.txt\n",
      stderr: "",
      exitCode: 0,
    }));
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Add File: nested/new.txt\n" +
        "+created\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Success. Updated the following files");
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: root,
        patch: expect.stringContaining("*** Add File: nested/new.txt"),
      }),
    );
  });

  test("accepts the upstream Codex JSON input key", async () => {
    const runner = vi.fn<ApplyPatchRunner>(async () => ({
      stdout: "Success. Updated the following files:\nA new.txt\n",
      stderr: "",
      exitCode: 0,
    }));
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      input:
        "*** Begin Patch\n" +
        "*** Add File: nested/new.txt\n" +
        "+created\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.stringContaining("*** Add File: nested/new.txt"),
      }),
    );
  });

  test("rejects git unified diffs with apply_patch grammar guidance", async () => {
    const runner = vi.fn<ApplyPatchRunner>();
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "diff --git a/CMakeLists.txt b/CMakeLists.txt\n" +
        "--- a/CMakeLists.txt\n" +
        "+++ b/CMakeLists.txt\n" +
        "@@\n" +
        "-old\n" +
        "+new\n",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a git unified diff");
    expect(result.content).toContain("*** Begin Patch");
    expect(runner).not.toHaveBeenCalled();
  });

  test("rejects absolute patch paths", async () => {
    const runner = vi.fn<ApplyPatchRunner>();
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        `*** Add File: ${join(root, "absolute.txt")}\n` +
        "+blocked\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("patch paths must be relative");
    expect(runner).not.toHaveBeenCalled();
  });

  test("rejects patch targets outside allowed roots", async () => {
    const runner = vi.fn<ApplyPatchRunner>();
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Add File: ../outside.txt\n" +
        "+blocked\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside allowed directories");
    expect(runner).not.toHaveBeenCalled();
  });

  test("passes update patches through and returns runner failures", async () => {
    await writeFile(join(root, "target.txt"), "old\n", "utf8");
    const runner = vi.fn<ApplyPatchRunner>(async () => ({
      stdout: "",
      stderr: "Failed to find expected lines",
      exitCode: 1,
    }));
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: target.txt\n" +
        "@@\n" +
        "-missing\n" +
        "+new\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed to find expected lines");
    expect(runner).toHaveBeenCalledOnce();
  });

  test("validates move destinations", async () => {
    await mkdir(join(root, "old"), { recursive: true });
    await writeFile(join(root, "old/name.txt"), "old\n", "utf8");
    const runner = vi.fn<ApplyPatchRunner>();
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: old/name.txt\n" +
        "*** Move to: ../renamed.txt\n" +
        "@@\n" +
        "-old\n" +
        "+new\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("patch target is outside allowed directories");
    expect(runner).not.toHaveBeenCalled();
  });
});
