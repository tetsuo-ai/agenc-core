import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import type { BashToolConfig } from "./types.js";
import {
  UnifiedExecError,
  UnifiedExecProcessManager,
  type UnifiedExecProcessManagerLike,
} from "../../unified-exec/index.js";

export interface ExecCommandToolConfig extends BashToolConfig {
  readonly allowedPaths?: readonly string[];
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
}

const PLAIN_INTERACTIVE_SHELL_RE =
  /^\s*(?:(?:\/[\w.-]+)+\/)?(?:bash|dash|ksh|sh|zsh)(?:\s+-[A-Za-z]*[il][A-Za-z]*)*\s*$/u;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isPlainInteractiveShellCommand(command: string): boolean {
  return PLAIN_INTERACTIVE_SHELL_RE.test(command);
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: safeStringify({
      error: message,
      ...(error instanceof UnifiedExecError ? { code: error.code } : {}),
    }),
    isError: true,
  };
}

export function createExecCommandTool(config?: ExecCommandToolConfig): Tool {
  const manager =
    config?.unifiedExecManager ??
    new UnifiedExecProcessManager({
      cwd: config?.cwd,
      env: config?.env,
      maxTimeoutMs: config?.maxTimeoutMs,
    });
  return {
    name: "exec_command",
    description:
      "Run a shell command in the current AgenC workspace and return captured stdout/stderr. Use this for inspection, tests, builds, and other terminal work. Use Edit or Write for source-file edits.",
    metadata: {
      family: "terminal",
      source: "builtin",
      keywords: ["exec", "command", "shell", "terminal", "bash", "agenc"],
      preferredProfiles: ["coding", "validation", "operator"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
    },
    requiresApproval: true,
    concurrencyClass: { kind: "background_terminal" },
    isReadOnly: false,
    supportsParallelToolCalls: false,
    isConcurrencySafe: () => false,
    interruptBehavior: () => "cancel",
    inputSchema: {
      type: "object",
      properties: {
        cmd: {
          type: "string",
          description: "Shell command to execute.",
        },
        command: {
          type: "string",
          description:
            "Compatibility alias for cmd. Prefer cmd for AgenC calls.",
        },
        workdir: {
          type: "string",
          description: "Working directory. Defaults to the AgenC workspace root.",
        },
        cwd: {
          type: "string",
          description:
            "Compatibility alias for workdir. Prefer workdir for AgenC calls.",
        },
        timeoutMs: {
          type: "number",
          description:
            "Optional hard command timeout in milliseconds. Prefer yield_time_ms for long-running commands you want to keep alive.",
        },
        yield_time_ms: {
          type: "number",
          description:
            "How long to wait for output before returning. If the process is still running, AgenC returns a session_id for write_stdin.",
        },
        max_output_tokens: {
          type: "number",
          description:
            "Maximum output tokens to return. Long output is truncated head/tail.",
        },
        login: {
          type: "boolean",
          description:
            "Run the command through a login shell where supported.",
        },
        tty: {
          type: "boolean",
          description:
            "Allocate an interactive PTY. Required for persistent shells and write_stdin.",
        },
        shell: {
          type: "string",
          description:
            "Shell executable to run the command through. Defaults to the user's shell.",
        },
        sandbox_permissions: {
          type: "object",
          description:
            "Permissions field accepted for request shape parity.",
        },
        additional_permissions: {
          type: "object",
          description:
            "Additional permissions field accepted for request shape parity.",
        },
        justification: {
          type: "string",
          description: "Why elevated execution is needed, when applicable.",
        },
        prefix_rule: {
          type: "array",
          items: { type: "string" },
          description: "Approval-cache command prefix rule, when applicable.",
        },
      },
      anyOf: [{ required: ["cmd"] }, { required: ["command"] }],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as Record<string, unknown> & ToolExecutionInjectedArgs;
      const cmd = asString(args.cmd) ?? asString(args.command);
      if (!cmd) {
        return {
          content: safeStringify({ error: "cmd must be a non-empty string" }),
          isError: true,
        };
      }
      const workdir = asString(args.workdir) ?? asString(args.cwd);
      const timeoutMs = asNumber(args.timeoutMs);
      const tty = asBoolean(args.tty);

      if (!(tty === true && isPlainInteractiveShellCommand(cmd))) {
        const workspaceWriteDecision = classifyShellWorkspaceWritePolicy({
          toolName: "exec_command",
          args: {
            command: cmd,
            ...(workdir !== undefined ? { cwd: workdir } : {}),
          },
          workspaceRoot: config?.cwd ?? config?.allowedPaths?.[0],
        });
        if (workspaceWriteDecision.blocked) {
          return {
            content: safeStringify({
              error:
                workspaceWriteDecision.message ??
                "Shell workspace write policy blocked the command.",
            }),
            isError: true,
          };
        }
      }

      try {
        const output = await manager.execCommand({
          cmd,
          callId: asString(args.__callId),
          ...(workdir !== undefined ? { workdir } : {}),
          ...(asString(args.shell) !== undefined ? { shell: asString(args.shell) } : {}),
          ...(asBoolean(args.login) !== undefined ? { login: asBoolean(args.login) } : {}),
          ...(tty !== undefined ? { tty } : {}),
          ...(asNumber(args.yield_time_ms) !== undefined
            ? { yield_time_ms: asNumber(args.yield_time_ms) }
            : {}),
          ...(asNumber(args.max_output_tokens) !== undefined
            ? { max_output_tokens: asNumber(args.max_output_tokens) }
            : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(args.__abortSignal !== undefined
            ? { __abortSignal: args.__abortSignal }
            : {}),
          ...(args.__onProgress !== undefined
            ? { __onProgress: args.__onProgress }
            : {}),
          ...(config?.execObserver !== undefined
            ? { observer: config.execObserver }
            : {}),
        });
        const isError = output.exitCode !== null && output.exitCode !== 0;
        // Flatten the result content to plain text so the model sees the
        // raw stdout/stderr instead of a JSON-encoded blob it has to
        // re-parse. Mirrors openclaude's `BashTool` `tool_result.content`
        // shape (plain string, structured flags on the result envelope).
        // Structured fields (exitCode, durationMs, timedOut, etc.) move
        // into `metadata` where in-process consumers can still read them.
        return {
          content: output.output,
          isError: isError || undefined,
          metadata: {
            command: cmd,
            cwd: workdir ?? config?.cwd ?? process.cwd(),
            tty: tty ?? false,
            exitCode: output.exitCode,
            stdout: output.stdout,
            stderr: output.stderr,
            timedOut: output.timedOut,
            truncated: output.truncated,
            durationMs: output.durationMs,
            ...(output.process_id !== undefined
              ? { processId: output.process_id, sessionId: output.process_id }
              : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
