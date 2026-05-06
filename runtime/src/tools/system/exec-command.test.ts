import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createExecCommandTool,
  runtimeSandboxForExec,
} from "./exec-command.js";
import { createWriteStdinTool } from "./write-stdin.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";
import { attachToolRuntimeContext } from "../runtimes/context.js";

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

function failedExecOutput(stderr: string, exitCode: number): ExecCommandToolOutput {
  return {
    output: stderr,
    stdout: "",
    stderr,
    exitCode,
    exit_code: exitCode,
    durationMs: 12,
    wall_time_seconds: 0.012,
    timedOut: false,
    truncated: false,
    original_token_count: 3,
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

  test("threads network policy interfaces into runtime sandbox requests", () => {
    const policyDecider = { decide: () => ({ decision: "allow" as const }) };
    const blockedRequestObserver = { onBlockedRequest: () => undefined };
    const args: Record<string, unknown> = {};

    attachToolRuntimeContext(args, {
      callId: "call-network-proxy",
      toolName: "exec_command",
      runtimeKind: "function",
      classification: "exclusive",
      supportsParallelToolCalls: false,
      source: { type: "model" },
      submittedAtMs: 0,
      approvalPolicy: "never",
      requestedSandboxMode: "read_only",
      sandboxMode: "read_only",
      approvalResolved: true,
      rawArgs: "{}",
      invocation: {
        payload: { kind: "function", arguments: "{}" },
        turn: {
          subId: "turn-network-proxy",
          cwd: root,
          agencLinuxSandboxExe: "/bin/true",
          networkSandboxPolicy: {
            allowlist: [],
            denylist: [],
            allowManagedDomainsOnly: false,
            enabled: true,
          },
          network: {
            policyDecider,
            blockedRequestObserver,
          },
        },
      },
    } as never);

    const runtimeSandbox = runtimeSandboxForExec(args, root);

    expect(runtimeSandbox?.networkPolicyDecider).toBe(policyDecider);
    expect(runtimeSandbox?.blockedRequestObserver).toBe(blockedRequestObserver);
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
    expect(result.content).toContain("Process exited with code 0");
    expect(result.content).toContain("Output:\nran");
    expect(result.codeModeResult).toMatchObject({
      wall_time_seconds: 0.001,
      exit_code: 0,
      output: "ran",
    });
  });

  test("returns AgenC-style visible exit status for failed commands", async () => {
    const execCommand = vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
      async () => failedExecOutput("compiler failed\n", 2),
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

    const result = await tool.execute({ cmd: "make", workdir: root });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Wall time: 0.0120 seconds");
    expect(result.content).toContain("Process exited with code 2");
    expect(result.content).toContain("Original token count: 3");
    expect(result.content).toContain("Output:\ncompiler failed\n");
    expect(result.codeModeResult).toMatchObject({
      wall_time_seconds: 0.012,
      exit_code: 2,
      output: "compiler failed\n",
    });
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
        const startedBody = started.codeModeResult as { session_id?: number };
        expect(started.isError).toBeUndefined();
        expect(startedBody.session_id).toEqual(expect.any(Number));
        expect(started.content).toContain(
          `Process running with session ID ${startedBody.session_id}`,
        );

        const echoed = await writeStdin.execute({
          session_id: startedBody.session_id,
          chars: "printf agenc-pty\\n\n",
          yield_time_ms: 250,
        });
        expect(echoed.isError).toBeUndefined();
        expect(echoed.content).toContain("agenc-pty");
        expect(echoed.codeModeResult).toMatchObject({
          session_id: startedBody.session_id,
        });
      } finally {
        await manager.closeAll("test_cleanup");
      }
    },
  );
});
