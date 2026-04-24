import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createExecCommandTool } from "./exec-command.js";
import type { ApplyPatchRunner } from "./apply-patch.js";

describe("exec_command tool", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-exec-command-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("intercepts common apply_patch heredocs and routes through apply_patch", async () => {
    const runner = vi.fn<ApplyPatchRunner>(async () => ({
      stdout: "Success. Updated the following files:\nA new.txt\n",
      stderr: "",
      exitCode: 0,
    }));
    const tool = createExecCommandTool({
      cwd: root,
      allowedPaths: [root],
      applyPatchRunner: runner,
    });

    const result = await tool.execute({
      cmd:
        "apply_patch <<'PATCH'\n" +
        "*** Begin Patch\n" +
        "*** Add File: new.txt\n" +
        "+created\n" +
        "*** End Patch\n" +
        "PATCH",
      workdir: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Success. Updated the following files");
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: root,
        patch: expect.stringContaining("*** Add File: new.txt"),
      }),
    );
  });
});
