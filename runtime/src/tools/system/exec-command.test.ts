import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createExecCommandTool } from "./exec-command.js";
import { createWriteStdinTool } from "./write-stdin.js";
import type { ApplyPatchRunner } from "./apply-patch.js";
import { UnifiedExecProcessManager } from "../../unified-exec/index.js";

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

  test("returns a session id for live PTY commands and write_stdin can resume it", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: root });
    const exec = createExecCommandTool({
      cwd: root,
      allowedPaths: [root],
      unifiedExecManager: manager,
    });
    const writeStdin = createWriteStdinTool({
      cwd: root,
      unifiedExecManager: manager,
    });

    try {
      const started = await exec.execute({
        cmd: "bash -i",
        tty: true,
        yield_time_ms: 250,
      });
      const startedBody = JSON.parse(started.content) as {
        session_id?: number;
      };
      expect(started.isError).toBeUndefined();
      expect(startedBody.session_id).toEqual(expect.any(Number));

      const echoed = await writeStdin.execute({
        session_id: startedBody.session_id,
        chars: "printf agenc-pty\\n\n",
        yield_time_ms: 250,
      });
      expect(echoed.isError).toBeUndefined();
      expect(JSON.parse(echoed.content)).toMatchObject({
        stdout: expect.stringContaining("agenc-pty"),
        session_id: startedBody.session_id,
      });
    } finally {
      await manager.closeAll("test_cleanup");
    }
  });
});
