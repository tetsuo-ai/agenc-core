import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createExecCommandTool as createUnboundExecCommandTool,
  runtimeSandboxForExec,
} from "./exec-command.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { createWriteStdinTool as createUnboundWriteStdinTool } from "./write-stdin.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";
import { attachToolRuntimeContext } from "../runtimes/context.js";

const createExecCommandTool = (
  config: Parameters<typeof createUnboundExecCommandTool>[0],
) => bindExplicitDangerBoundary(createUnboundExecCommandTool(config));
const createWriteStdinTool = (
  config: Parameters<typeof createUnboundWriteStdinTool>[0],
) => bindExplicitDangerBoundary(createUnboundWriteStdinTool(config));

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

function timedOutExecOutput(partialStdout: string): ExecCommandToolOutput {
  return {
    output: partialStdout,
    stdout: partialStdout,
    stderr: "",
    exitCode: null,
    exit_code: null,
    durationMs: 5_000,
    wall_time_seconds: 5.0,
    timedOut: true,
    truncated: true,
    original_token_count: 5,
  };
}

function signalKilledExecOutput(partialStdout: string): ExecCommandToolOutput {
  return {
    output: partialStdout,
    stdout: partialStdout,
    stderr: "",
    exitCode: null,
    exit_code: null,
    durationMs: 42,
    wall_time_seconds: 0.042,
    timedOut: false,
    truncated: false,
    original_token_count: 2,
  };
}

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
    // Output now leads, footer carries metadata. See exec-result-format.ts
    // for why the order was inverted.
    expect(result.content).toMatch(/^ran/);
    expect(result.content).toContain("[exec exit_code=0");
    expect(result.codeModeResult).toMatchObject({
      wall_time_seconds: 0.001,
      exit_code: 0,
      output: "ran",
    });
  });

  test("blocks MCP tool names and simulation placeholders from exec_command", async () => {
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

    await expect(
      tool.execute({ cmd: "mcp.audit-ping.ping", workdir: root }),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("MCP tools are not shell commands"),
    });
    await expect(
      tool.execute({ cmd: 'echo "Attempting direct MCP call"', workdir: root }),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("Do not simulate MCP results"),
    });
    await expect(
      tool.execute({
        cmd: 'python3 -c "print(\'Direct call simulation\')"',
        workdir: root,
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("Do not simulate MCP results"),
    });
    await expect(
      tool.execute({
        cmd: 'echo "This is a placeholder, I need to call the actual MCP tool"',
        workdir: root,
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("Do not simulate MCP results"),
    });
    expect(execCommand).not.toHaveBeenCalled();
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
    // Output leads, footer carries metadata.
    expect(result.content).toMatch(/^compiler failed/);
    expect(result.content).toContain("exit_code=2");
    expect(result.content).toContain("wall_time=0.0120s");
    expect(result.content).toContain("tokens=3");
    expect(result.codeModeResult).toMatchObject({
      wall_time_seconds: 0.012,
      exit_code: 2,
      output: "compiler failed\n",
    });
  });

  test("flags signal-killed exec (exitCode null, not timeout) as isError with explicit signal_terminated marker", async () => {
    const manager: UnifiedExecProcessManagerLike = {
      maxTimeoutMs: 30_000,
      execCommand: vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
        async () => signalKilledExecOutput("partial output\n"),
      ),
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

    const result = await tool.execute({ cmd: "npm test", workdir: root });

    // The previous behavior reported isError=undefined for null exitCode,
    // making a SIGKILL'd test runner look like a passing test. Pin
    // isError=true and require an explicit signal_terminated=true marker
    // in both content and codeModeResult so the model can distinguish
    // clean exits from killed processes.
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^partial output/);
    expect(result.content).toContain("signal_terminated=true");
    expect(result.content).not.toContain("exit_code=");
    expect(result.codeModeResult).toMatchObject({
      signal_terminated: true,
      output: "partial output\n",
    });
    expect(result.codeModeResult).not.toHaveProperty("exit_code");
  });

  test("flags timed-out exec (exitCode null, timedOut true) as isError with timed_out marker", async () => {
    const manager: UnifiedExecProcessManagerLike = {
      maxTimeoutMs: 30_000,
      execCommand: vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
        async () => timedOutExecOutput("slow output\n"),
      ),
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
      cmd: "while true; do echo hi; done",
      workdir: root,
      timeout_ms: 5_000,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^slow output/);
    expect(result.content).toContain("timed_out=true");
    expect(result.content).not.toContain("signal_terminated=true");
    expect(result.codeModeResult).toMatchObject({
      timed_out: true,
      output: "slow output\n",
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

  test(
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
        // session_id is now in the compact footer rather than a free-text
        // line. See exec-result-format.ts for the format change.
        expect(started.content).toContain(
          `session_id=${startedBody.session_id}`,
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
