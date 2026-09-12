import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createExecCommandTool as createUnboundExecCommandTool,
  runtimeSandboxForExec,
} from "./exec-command.js";
import { RESIDUAL_PROCESSES_NOTE } from "./exec-result-format.js";
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

  // Live incident (session conv-mtjdmlfc, 2026-09-02): 21 `npm start` calls
  // over 412 s, each denied by the sandbox, each answered only by the child's
  // own errno text and an escalation request the parser silently discarded.
  describe("a sandbox denial answers the model definitively", () => {
    function sandboxedArgs(
      overrides: Record<string, unknown>,
      approvalPolicy = "never",
    ): Record<string, unknown> {
      const args: Record<string, unknown> = { ...overrides };
      attachToolRuntimeContext(args, {
        callId: "call-sandbox-denial",
        toolName: "exec_command",
        runtimeKind: "function",
        classification: "exclusive",
        supportsParallelToolCalls: false,
        source: { type: "model" },
        submittedAtMs: 0,
        approvalPolicy,
        requestedSandboxMode: "read_only",
        sandboxMode: "read_only",
        approvalResolved: true,
        rawArgs: "{}",
        invocation: {
          session: { services: { runtimeOptions: { sessionTempRoot: root } } },
          payload: { kind: "function", arguments: "{}" },
          turn: {
            subId: "turn-sandbox-denial",
            cwd: root,
            agencLinuxSandboxExe: "/bin/true",
          },
        },
      } as never);
      return args;
    }

    function toolWith(output: ExecCommandToolOutput) {
      const execCommand = vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
        async () => output,
      );
      const manager: UnifiedExecProcessManagerLike = {
        maxTimeoutMs: 30_000,
        execCommand,
        writeStdin: vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(
          async () => completedExecOutput(""),
        ),
        closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(async () => {}),
      };
      return {
        execCommand,
        tool: createExecCommandTool({
          cwd: root,
          allowedPaths: [root],
          unifiedExecManager: manager,
        }),
      };
    }

    const BIND_DENIED = failedExecOutput(
      "Error: listen EPERM: operation not permitted 0.0.0.0:8080",
      1,
    );

    test("a removed alias names the field that replaced it, so the model can correct the call", async () => {
      const { tool } = toolWith(completedExecOutput(""));
      const byCwd = await tool.execute(sandboxedArgs({ cmd: "npm test", cwd: root }));
      expect(byCwd.isError).toBe(true);
      expect(String(byCwd.content)).toContain("unknown field `cwd`");
      expect(String(byCwd.content)).toContain("`workdir`");
      const byCommand = await tool.execute(sandboxedArgs({ command: "npm test" }));
      expect(byCommand.isError).toBe(true);
      expect(String(byCommand.content)).toContain("unknown field `command`");
      expect(String(byCommand.content)).toContain("`cmd`");
    });

    test("a denied bind says the sandbox did it and that retrying is pointless", async () => {
      const { tool } = toolWith(BIND_DENIED);
      const result = await tool.execute(sandboxedArgs({ cmd: "npm start", workdir: root }));

      expect(result.isError).toBe(true);
      // The child's own text is still there, unchanged.
      expect(result.content).toContain("listen EPERM");
      // And now so is the verdict.
      expect(result.content).toContain("[sandbox]");
      expect(result.content).toContain("Do not run this command again");
      expect(result.content).toContain("give them the exact command to run in their own terminal");
    });

    test("under a policy with a human it asks for one escalated retry instead", async () => {
      const { tool } = toolWith(BIND_DENIED);
      const result = await tool.execute(
        sandboxedArgs({ cmd: "npm start", workdir: root }, "on_request"),
      );
      expect(result.content).toContain("require_escalated");
      expect(result.content).not.toContain("Do not run this command again");
    });

    test("an ordinary failure is left alone", async () => {
      const { tool } = toolWith(failedExecOutput("npm ERR! missing script: start", 1));
      const result = await tool.execute(sandboxedArgs({ cmd: "npm start", workdir: root }));
      expect(result.content).not.toContain("[sandbox]");
    });

    test("an unreadable escalation request is refused instead of dropped", async () => {
      // The schema used to invite `{type:"object"}` here and the parser threw
      // every object away, so the model could not tell a refused request from
      // an unread one.
      const { execCommand, tool } = toolWith(completedExecOutput("ran"));
      const result = await tool.execute(
        sandboxedArgs({
          cmd: "npm start",
          workdir: root,
          sandbox_permissions: { network: "full" },
        }),
      );

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content as string).error).toContain(
        'sandbox_permissions must be one of "default", "require_escalated" or "with_additional_permissions"',
      );
      expect(result.effectDisposition).toMatchObject({
        disposition: "confirmed_no_effect",
      });
      // Refused means not run.
      expect(execCommand).not.toHaveBeenCalled();
    });

    test("a malformed additional_permissions is refused too", async () => {
      const { execCommand, tool } = toolWith(completedExecOutput("ran"));
      const result = await tool.execute(
        sandboxedArgs({
          cmd: "npm start",
          workdir: root,
          sandbox_permissions: "with_additional_permissions",
          additional_permissions: { network: "full" },
        }),
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content as string).error).toContain(
        "additional_permissions has an unsupported shape",
      );
      expect(execCommand).not.toHaveBeenCalled();
    });

    test("the documented escalation values still run", async () => {
      const { execCommand, tool } = toolWith(completedExecOutput("ran"));
      const result = await tool.execute(
        sandboxedArgs({
          cmd: "echo hi",
          workdir: root,
          sandbox_permissions: "require_escalated",
          justification: "needs the network",
        }),
      );
      expect(result.isError).toBeUndefined();
      expect(execCommand).toHaveBeenCalledTimes(1);
    });
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
        session: {
          services: {
            runtimeOptions: { sessionTempRoot: root },
          },
        },
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
    expect(runtimeSandbox?.sessionTempRoot).toBe(root);
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
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
      evidenceRef: "tool:system.exec-command:workspace-write-policy",
    });
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
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_committed",
      evidenceKind: "provider_receipt",
      evidenceRef: "tool:system.exec-command:process-exit",
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

  describe("workspace deletions", () => {
    /** The command the live refactor session retried 14 times. */
    const REFACTOR_CLEANUP =
      "rm arcade15/game.js && ls -la arcade15 && node --check arcade15/main.js";

    function permissionArgs(
      cmd: string,
      permission: {
        readonly mode: string;
        readonly approvalResolved?: boolean;
        readonly approvalPolicy?: "on_request" | "never";
        readonly sandboxMode?: "danger_full_access" | "workspace_write";
      },
    ): Record<string, unknown> {
      const args: Record<string, unknown> = { cmd, workdir: root };
      attachToolRuntimeContext(args, {
        callId: "call-delete",
        toolName: "exec_command",
        runtimeKind: "function",
        classification: "exclusive",
        supportsParallelToolCalls: false,
        source: { type: "model" },
        submittedAtMs: 0,
        approvalPolicy: permission.approvalPolicy ?? "on_request",
        requestedSandboxMode: permission.sandboxMode ?? "danger_full_access",
        sandboxMode: permission.sandboxMode ?? "danger_full_access",
        approvalResolved: permission.approvalResolved ?? false,
        rawArgs: "{}",
        invocation: {
          session: {
            permissionModeRegistry: { current: () => ({ mode: permission.mode }) },
            services: { runtimeOptions: { sessionTempRoot: root } },
          },
          payload: { kind: "function", arguments: "{}" },
          turn: { subId: "turn-delete", cwd: root },
        },
      } as never);
      return args;
    }

    function deletionTool() {
      const execCommand = vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
        async () => completedExecOutput("ran"),
      );
      const tool = createExecCommandTool({
        cwd: root,
        allowedPaths: [root],
        unifiedExecManager: {
          maxTimeoutMs: 30_000,
          execCommand,
          writeStdin: vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(
            async () => completedExecOutput(""),
          ),
          closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(async () => {}),
        },
      });
      return { tool, execCommand };
    }

    test("runs rm on a workspace file under bypassPermissions", async () => {
      const { tool, execCommand } = deletionTool();

      const result = await tool.execute(
        permissionArgs(REFACTOR_CLEANUP, { mode: "bypassPermissions" }),
      );

      expect(result.isError).toBeUndefined();
      expect(execCommand).toHaveBeenCalledTimes(1);
      expect(execCommand.mock.calls[0]?.[0]).toMatchObject({ cmd: REFACTOR_CLEANUP });
    });

    // Never touched by the refusal cases: the policy refuses before anything
    // spawns. Chosen outside the workspace, the temp directory and the
    // hermetic home the test harness points HOME and AGENC_HOME at (the home
    // is a protected path with its own message).
    const outside = "/srv/agenc-outside-workspace/outside.txt";

    test("refuses rm outside the workspace under bypassPermissions while a sandbox is on", async () => {
      // `--bypass-approvals`: prompts off, the OS sandbox stays the boundary,
      // so the policy still keeps shell removals to the workspace.
      const { tool, execCommand } = deletionTool();

      const result = await tool.execute(
        permissionArgs(`rm ${outside}`, {
          mode: "bypassPermissions",
          sandboxMode: "workspace_write",
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("shell_workspace_file_delete_disallowed");
      expect(result.content).toContain("only inside the workspace");
      expect(result.effectDisposition).toMatchObject({
        disposition: "confirmed_no_effect",
        evidenceRef: "tool:system.exec-command:workspace-write-policy",
      });
      expect(execCommand).not.toHaveBeenCalled();
    });

    test("runs rm outside the workspace under the full bypass", async () => {
      // `--dangerously-bypass-approvals-and-sandbox`: bypassPermissions and
      // danger-full-access together. Nothing but this policy would gate the
      // removal, and the user chose that.
      const { tool, execCommand } = deletionTool();

      const result = await tool.execute(
        permissionArgs(`rm ${outside}`, { mode: "bypassPermissions" }),
      );

      expect(result.isError).toBeUndefined();
      expect(execCommand).toHaveBeenCalledTimes(1);
    });

    test("runs a command with an unresolvable write target under the full bypass", async () => {
      // 51 of 459 shell calls in one Terminal-Bench task were refused as
      // indeterminate, most for an `echo "$(...)"` beside a harmless write.
      const { tool, execCommand } = deletionTool();

      const result = await tool.execute(
        permissionArgs('for f in refs/heads/*; do echo "$f: $(cat $f)"; done > /tmp/agenc-refs.txt', {
          mode: "bypassPermissions",
          approvalPolicy: "never",
        }),
      );

      expect(result.isError).toBeUndefined();
      expect(execCommand).toHaveBeenCalledTimes(1);
    });

    test("the full bypass keeps the protected paths refused", async () => {
      const { tool, execCommand } = deletionTool();

      const result = await tool.execute(
        permissionArgs("rm -rf .git", { mode: "bypassPermissions", approvalPolicy: "never" }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("protected paths");
      expect(execCommand).not.toHaveBeenCalled();
    });

    test("refuses rm of a protected path under bypassPermissions", async () => {
      const { tool, execCommand } = deletionTool();

      const result = await tool.execute(
        permissionArgs("rm .git/config", { mode: "bypassPermissions" }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("shell_workspace_file_delete_disallowed");
      expect(result.content).toContain("protected paths");
      expect(execCommand).not.toHaveBeenCalled();
    });

    test("still refuses a redirect write into a source file under bypassPermissions", async () => {
      const { tool, execCommand } = deletionTool();

      const result = await tool.execute(
        permissionArgs("cat > src/x.js <<'EOF'\nexport const x = 1;\nEOF", {
          mode: "bypassPermissions",
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("shell_workspace_file_write_disallowed");
      expect(execCommand).not.toHaveBeenCalled();
    });

    test("a deletion under a prompting mode runs only after the approval path", async () => {
      const { tool, execCommand } = deletionTool();

      const unapproved = await tool.execute(
        permissionArgs(REFACTOR_CLEANUP, { mode: "default" }),
      );
      expect(unapproved.isError).toBe(true);
      expect(unapproved.content).toContain(
        "shell_workspace_file_delete_requires_approval",
      );
      expect(unapproved.content).toContain("ask the user to approve this exact command");
      expect(execCommand).not.toHaveBeenCalled();

      const approved = await tool.execute(
        permissionArgs(REFACTOR_CLEANUP, { mode: "default", approvalResolved: true }),
      );
      expect(approved.isError).toBeUndefined();
      expect(execCommand).toHaveBeenCalledTimes(1);
    });

    test("a session that never asks may delete without a resolver decision", async () => {
      const { tool, execCommand } = deletionTool();

      const result = await tool.execute(
        permissionArgs(REFACTOR_CLEANUP, { mode: "default", approvalPolicy: "never" }),
      );

      expect(result.isError).toBeUndefined();
      expect(execCommand).toHaveBeenCalledTimes(1);
    });
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

  describe("detach", () => {
    function fullAccessArgs(overrides: Record<string, unknown>): Record<string, unknown> {
      const args: Record<string, unknown> = { ...overrides };
      attachToolRuntimeContext(args, {
        callId: "call-detach",
        toolName: "exec_command",
        runtimeKind: "function",
        classification: "exclusive",
        supportsParallelToolCalls: false,
        source: { type: "model" },
        submittedAtMs: 0,
        approvalPolicy: "never",
        requestedSandboxMode: "danger_full_access",
        sandboxMode: "danger_full_access",
        approvalResolved: true,
        rawArgs: "{}",
        invocation: {
          session: { services: { runtimeOptions: { sessionTempRoot: root } } },
          payload: { kind: "function", arguments: "{}" },
          turn: { subId: "turn-detach", cwd: root },
        },
      } as never);
      return args;
    }

    function sandboxedArgs(overrides: Record<string, unknown>): Record<string, unknown> {
      const args: Record<string, unknown> = { ...overrides };
      attachToolRuntimeContext(args, {
        callId: "call-detach-sandboxed",
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
          session: { services: { runtimeOptions: { sessionTempRoot: root } } },
          payload: { kind: "function", arguments: "{}" },
          turn: {
            subId: "turn-detach-sandboxed",
            cwd: root,
            agencLinuxSandboxExe: "/bin/true",
          },
        },
      } as never);
      return args;
    }

    function detachedOutput(overrides: Partial<ExecCommandToolOutput>): ExecCommandToolOutput {
      return {
        ...completedExecOutput("starting"),
        exitCode: null,
        exit_code: null,
        detached: true,
        log_path: "/srv/agenc-session/detached/service.log",
        ...overrides,
      };
    }

    function toolWithManager(
      startDetachedProcess?: UnifiedExecProcessManagerLike["startDetachedProcess"],
    ) {
      const execCommand = vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
        async () => completedExecOutput("ran"),
      );
      const manager: UnifiedExecProcessManagerLike = {
        maxTimeoutMs: 30_000,
        execCommand,
        ...(startDetachedProcess !== undefined ? { startDetachedProcess } : {}),
        writeStdin: vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(
          async () => completedExecOutput(""),
        ),
        closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(async () => {}),
      };
      return {
        execCommand,
        tool: createExecCommandTool({
          cwd: root,
          allowedPaths: [root],
          unifiedExecManager: manager,
        }),
      };
    }

    test("starts a detached service and reports its pid and log", async () => {
      const startDetachedProcess = vi.fn<
        NonNullable<UnifiedExecProcessManagerLike["startDetachedProcess"]>
      >(async () => detachedOutput({ pid: 4242 }));
      const { tool, execCommand } = toolWithManager(startDetachedProcess);

      const result = await tool.execute(
        fullAccessArgs({ cmd: "nginx", detach: true, yield_time_ms: 500 }),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("starting");
      expect(result.content).toContain("running=true pid=4242");
      expect(result.content).toContain("detached=true");
      expect(result.content).toContain("log=/srv/agenc-session/detached/service.log");
      expect(startDetachedProcess).toHaveBeenCalledWith(
        expect.objectContaining({ cmd: "nginx", yield_time_ms: 500 }),
      );
      expect(execCommand).not.toHaveBeenCalled();
      expect(result.metadata).toMatchObject({ detached: true, pid: 4242 });
      expect(result.codeModeResult).toMatchObject({ running: true, detached: true, pid: 4242 });
      expect(result.effectDisposition).toMatchObject({
        disposition: "confirmed_committed",
        evidenceRef: "tool:system.exec-command:process-detached",
      });
    });

    test("a detached service that dies inside the window is an error with its exit code", async () => {
      const { tool } = toolWithManager(async () =>
        detachedOutput({ exitCode: 1, exit_code: 1, output: "bind() failed", stdout: "bind() failed" }),
      );

      const result = await tool.execute(fullAccessArgs({ cmd: "nginx", detach: true }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain("bind() failed");
      expect(result.content).toContain("exit_code=1");
      expect(result.content).toContain("detached=true");
    });

    test("refuses detach under a sandbox and names the flag and the alternative", async () => {
      const startDetachedProcess = vi.fn<
        NonNullable<UnifiedExecProcessManagerLike["startDetachedProcess"]>
      >(async () => detachedOutput({ pid: 1 }));
      const { tool, execCommand } = toolWithManager(startDetachedProcess);

      const result = await tool.execute(
        sandboxedArgs({ cmd: "python3 -m http.server 8080", detach: true, workdir: root }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("danger-full-access");
      expect(result.content).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(result.content).toContain("yield_time_ms");
      expect(result.metadata).toMatchObject({ kind: "exec_detach_unavailable", recoverable: true });
      expect(result.effectDisposition).toMatchObject({
        disposition: "confirmed_no_effect",
        evidenceRef: "tool:system.exec-command:detach-unavailable",
      });
      expect(startDetachedProcess).not.toHaveBeenCalled();
      expect(execCommand).not.toHaveBeenCalled();
    });

    test("refuses detach when the exec manager cannot detach", async () => {
      const { tool, execCommand } = toolWithManager();

      const result = await tool.execute(fullAccessArgs({ cmd: "nginx", detach: true }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not supported by this exec manager");
      expect(execCommand).not.toHaveBeenCalled();
    });

    test("refuses detach together with tty", async () => {
      const { tool, execCommand } = toolWithManager(async () => detachedOutput({ pid: 1 }));

      const result = await tool.execute(
        fullAccessArgs({ cmd: "nginx", detach: true, tty: true }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("detach cannot be combined with tty");
      expect(execCommand).not.toHaveBeenCalled();
    });

    test("the residue note follows the footer when leftover processes were stopped", async () => {
      // Before: `nginx` returned exit 0, the daemon was gone, and the model
      // had no way to learn why. Now the result says so and points at detach.
      const { tool } = toolWithManager();
      const execCommand = vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
        async () => ({
          ...completedExecOutput("nginx started"),
          residual_processes_terminated: true,
        }),
      );
      const noteTool = createExecCommandTool({
        cwd: root,
        allowedPaths: [root],
        unifiedExecManager: {
          maxTimeoutMs: 30_000,
          execCommand,
          writeStdin: vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(
            async () => completedExecOutput(""),
          ),
          closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(async () => {}),
        },
      });
      void tool;

      const result = await noteTool.execute(fullAccessArgs({ cmd: "nginx" }));

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("nginx started");
      expect(result.content).toContain("[exec exit_code=0");
      expect(result.content).toContain(RESIDUAL_PROCESSES_NOTE);
      expect(result.metadata).toMatchObject({ residualProcessesTerminated: true });
      expect(result.codeModeResult).toMatchObject({ residual_processes_terminated: true });
    });
  });
});
