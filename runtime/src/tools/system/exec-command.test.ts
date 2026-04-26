import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createExecCommandTool } from "./exec-command.js";
import { createWriteStdinTool } from "./write-stdin.js";
import {
  UnifiedExecProcessManager,
  type ExecCommandToolOutput,
  type UnifiedExecProcessManagerLike,
} from "../../unified-exec/index.js";

function completedExecOutput(stdout: string): ExecCommandToolOutput {
  return {
    output: stdout,
    stdout,
    stderr: "",
    exitCode: 0,
    exit_code: 0,
    durationMs: 1,
    wall_time_seconds: 0.001,
    timedOut: false,
    truncated: false,
    original_token_count: 1,
  };
}

const require = createRequire(import.meta.url);
const hasPtySupport = (() => {
  try {
    require.resolve("@homebridge/node-pty-prebuilt-multiarch");
    return true;
  } catch {
    return false;
  }
})();

describe("exec_command tool", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-exec-command-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("blocks shell redirection writes into workspace files", async () => {
    const execCommand = vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
      async () => completedExecOutput("ran"),
    );
    const manager: UnifiedExecProcessManagerLike = {
      maxTimeoutMs: 30_000,
      execCommand,
      writeStdin: vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(
        async () => completedExecOutput(""),
      ),
      closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(async () => {}),
    };
    const tool = createExecCommandTool({
      cwd: root,
      allowedPaths: [root],
      unifiedExecManager: manager,
    });

    const result = await tool.execute({
      cmd:
        "cat > CMakeLists.txt << 'EOF'\n" +
        "cmake_minimum_required(VERSION 3.14)\n" +
        "EOF",
      workdir: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("shell_workspace_file_write_disallowed");
    expect(execCommand).not.toHaveBeenCalled();
  });

  test("allows shell redirection under generated output roots", async () => {
    const execCommand = vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
      async () => completedExecOutput("ran"),
    );
    const manager: UnifiedExecProcessManagerLike = {
      maxTimeoutMs: 30_000,
      execCommand,
      writeStdin: vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(
        async () => completedExecOutput(""),
      ),
      closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(async () => {}),
    };
    const tool = createExecCommandTool({
      cwd: root,
      allowedPaths: [root],
      unifiedExecManager: manager,
    });

    const result = await tool.execute({
      cmd:
        "mkdir -p build && cat > build/generated.txt << 'EOF'\n" +
        "generated\n" +
        "EOF",
      workdir: root,
    });

    expect(result.isError).toBeUndefined();
    expect(execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining("build/generated.txt"),
        workdir: root,
      }),
    );
  });

  test("blocks shell redirection writes sent through write_stdin", async () => {
    const writeStdin = vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(
      async () => completedExecOutput("ran"),
    );
    const manager: UnifiedExecProcessManagerLike = {
      maxTimeoutMs: 30_000,
      execCommand: vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
        async () => completedExecOutput(""),
      ),
      writeStdin,
      closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(async () => {}),
    };
    const tool = createWriteStdinTool({
      cwd: root,
      allowedPaths: [root],
      unifiedExecManager: manager,
    });

    const result = await tool.execute({
      session_id: 1,
      chars: "cat > CMakeLists.txt << 'EOF'\nproject(x)\nEOF\n",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("shell_workspace_file_write_disallowed");
    expect(writeStdin).not.toHaveBeenCalled();
  });

  test.runIf(hasPtySupport)(
    "returns a session id for live PTY commands and write_stdin can resume it",
    async () => {
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
    },
  );
});
