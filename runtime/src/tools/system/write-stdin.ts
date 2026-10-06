import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import { shellWorkspaceMutationPermission } from "./shell-mutation-permission.js";
import { preflightShellWorkspaceWritePolicy } from "./shell-preflight.js";
import { UnifiedExecError } from "../../unified-exec/types.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type { UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";
import { processOwnerIdFromToolArgs } from "../../unified-exec/process-ownership.js";
import {
  formatUnifiedExecToolContent,
  unifiedExecCodeModeResult,
} from "./exec-result-format.js";
import { buildRecoverableToolFailureMetadata } from "../result-metadata.js";
import {
  confirmedNoEffectDisposition,
  runtimeSandboxForExec,
  SANDBOX_PERMISSION_INPUT_PROPERTIES,
} from "./exec-command.js";
import { SandboxExecutionError } from "../../sandbox/execution-broker.js";
import { createToolEffectDispositionEvidence } from "../effect-boundary.js";
import { readToolRuntimeContext } from "../runtimes/context.js";
import { sandboxEscalationAvailable } from "./exec-sandbox-denial.js";
import { execNetworkFailureNotice } from "./exec-network-failure.js";

export interface WriteStdinToolConfig {
  readonly lightMode?: boolean;
  readonly cwd?: string;
  readonly allowedPaths?: readonly string[];
  readonly env?: Record<string, string>;
  readonly maxTimeoutMs?: number;
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * A failure that happened before any byte reached the process: an argument the
 * tool rejected, a session it could not find or reach, a closed stdin, or a
 * sandbox boundary it could not build. These carry a confirmed no-effect
 * disposition; without it the admission layer files the error as an unknown
 * outcome, poisons the live effect, and blocks every side-effecting tool of the
 * session until an operator runs `/resolve` (desktop soak, 2026-09-06). Only a
 * write that failed after it started stays undecided.
 */
function preWriteFailure(error: unknown, message: string): Partial<ToolResult> {
  if (error instanceof UnifiedExecError && error.code === "stdin_write_failed") {
    return {};
  }
  return {
    effectDisposition: confirmedNoEffectDisposition(
      "tool:system.write-stdin:pre-write-error",
      message,
    ),
  };
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: safeStringify({
      error: message,
      ...(error instanceof UnifiedExecError ? { code: error.code } : {}),
    }),
    isError: true,
    ...(error instanceof UnifiedExecError || error instanceof SandboxExecutionError
      ? preWriteFailure(error, message)
      : {}),
  };
}

function argumentErrorResult(message: string): ToolResult {
  return {
    content: safeStringify({ error: message }),
    isError: true,
    effectDisposition: confirmedNoEffectDisposition(
      "tool:system.write-stdin:argument-error",
      message,
    ),
  };
}
export function createWriteStdinTool(config?: WriteStdinToolConfig): Tool {
  const manager =
    config?.unifiedExecManager ??
    new UnifiedExecProcessManager({
      cwd: config?.cwd,
      env: config?.env,
      maxTimeoutMs: config?.maxTimeoutMs,
    });

  return {
    name: "write_stdin",
    description:
      "Interact with a live exec_command session by session_id. Pass chars='' to poll for more output from ANY still-running session (background commands included — tty not required). Sending non-empty input requires the session to have been started with tty=true.",
    metadata: {
      family: "terminal",
      source: "builtin",
      keywords: ["stdin", "pty", "terminal", "interactive", "session"],
      preferredProfiles: ["coding", "validation", "operator"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
    },
    // TOOL-02: non-empty stdin is a second shell channel; require approval
    // under on_request (empty poll still hits approval once — safer than opt-out).
    requiresApproval: true,
    concurrencyClass: { kind: "background_terminal" },
    isReadOnly: false,
    // Unified exec owns the bounded polling yield. The generic executor
    // must never turn a long poll into termination of the live process.
    timeoutBehavior: "tool",
    recoveryCategory: "side-effecting",
    supportsParallelToolCalls: false,
    isConcurrencySafe: () => false,
    interruptBehavior: () => "cancel",
    preflight(args) {
      const chars = asString(args.chars) ?? "";
      if (chars.trim().length === 0) return null;
      return preflightShellWorkspaceWritePolicy({
        toolName: "write_stdin",
        args: { command: chars, cwd: config?.cwd },
        workspaceRoot: config?.cwd ?? config?.allowedPaths?.[0],
        ...shellWorkspaceMutationPermission(args),
      });
    },
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "number",
          description:
            "The session_id returned by exec_command for a still-running process.",
        },
        chars: {
          type: "string",
          description:
            "Characters to write. Include newlines for shell commands. Use an empty string to poll output.",
        },
        yield_time_ms: {
          type: "number",
          description: "How long to wait for output after writing.",
        },
        max_output_tokens: {
          type: "number",
          description: "Maximum output tokens to return.",
        },
        ...SANDBOX_PERMISSION_INPUT_PROPERTIES,
        sandbox_permissions: {
          ...SANDBOX_PERMISSION_INPUT_PROPERTIES.sandbox_permissions,
          description:
            "Sandbox escalation mode. A session started by exec_command with sandbox_permissions runs in that sandbox; pass the same value here to reach it.",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as Record<string, unknown> & ToolExecutionInjectedArgs;
      if (Object.prototype.hasOwnProperty.call(args, "process_id")) {
        return argumentErrorResult("unknown field `process_id`");
      }
      const sessionId = asNumber(args.session_id);
      if (sessionId === undefined) {
        return argumentErrorResult("session_id must be a number");
      }
      const chars = asString(args.chars) ?? "";
      if (chars.trim().length > 0) {
        const workspaceWriteDecision = classifyShellWorkspaceWritePolicy({
          toolName: "write_stdin",
          args: { command: chars, cwd: config?.cwd },
          workspaceRoot: config?.cwd ?? config?.allowedPaths?.[0],
          ...shellWorkspaceMutationPermission(args),
        });
        if (workspaceWriteDecision.blocked) {
          const blockedMessage =
            workspaceWriteDecision.message ??
            "Shell workspace write policy blocked the input.";
          return {
            content: safeStringify({ error: blockedMessage }),
            isError: true,
            metadata: buildRecoverableToolFailureMetadata(
              "shell_workspace_write_policy",
            ),
            effectDisposition: confirmedNoEffectDisposition(
              "tool:system.write-stdin:workspace-write-policy",
              blockedMessage,
            ),
          };
        }
      }

      try {
        const runtimeSandbox = runtimeSandboxForExec(
          args,
          config?.cwd ?? process.cwd(),
        );
        const ownerId = processOwnerIdFromToolArgs(
          args as Record<string, unknown>,
        );
        const output = await manager.writeStdin({
          session_id: sessionId,
          callId: asString(args.__callId),
          chars,
          ...(asNumber(args.yield_time_ms) !== undefined
            ? { yield_time_ms: asNumber(args.yield_time_ms) }
            : {}),
          ...(asNumber(args.max_output_tokens) !== undefined
            ? { max_output_tokens: asNumber(args.max_output_tokens) }
            : {}),
          ...(args.__abortSignal !== undefined
            ? { __abortSignal: args.__abortSignal }
            : {}),
          ...(args.__onProgress !== undefined
            ? { __onProgress: args.__onProgress }
            : {}),
          ...(runtimeSandbox !== undefined ? { runtimeSandbox } : {}),
          ...(ownerId !== undefined ? { ownerId } : {}),
        });
        // gaphunt3 #4: mirror exec-command.ts so a signal-killed process
        // (exitCode === null, no process_id) is reported as an error instead
        // of a silent success. `process_id !== undefined` discriminates a
        // still-alive yielded process from a terminated one.
        const stillAlive =
          output.exitCode === null && output.process_id !== undefined;
        const isError =
          output.command_outcome !== undefined ||
          (output.exitCode !== null && output.exitCode !== 0) ||
          (output.exitCode === null && !stillAlive);
        const execContent = formatUnifiedExecToolContent(output, config?.lightMode === true);
        const runtimeContext = readToolRuntimeContext(args);
        const notice = execNetworkFailureNotice({
          output: execContent,
          exitCode: output.exitCode,
          runtimeSandbox,
          escalationAvailable: runtimeContext !== undefined &&
            sandboxEscalationAvailable(runtimeContext.approvalPolicy),
        });
        return {
          content: notice === null ? execContent : `${execContent}\n\n${notice}`,
          isError: isError || undefined,
          codeModeResult: unifiedExecCodeModeResult(output),
          // Ordinary terminal receipts settle this call without claiming
          // command success. Missing authenticated outcomes remain unknown
          // even when descendant cleanup has independently completed.
          effectDisposition: createToolEffectDispositionEvidence({
            disposition: output.command_outcome === undefined ? "confirmed_committed" : "remains_unknown",
            evidenceKind: "provider_receipt",
            evidenceRef: stillAlive
              ? "tool:system.write-stdin:process-yield"
              : "tool:system.write-stdin:process-exit",
            evidenceMaterial: JSON.stringify({
              sessionId,
              chars,
              exitCode: output.exitCode,
              commandOutcome: output.command_outcome ?? "reported",
              processId: output.process_id ?? null,
              timedOut: output.timedOut,
              durationMs: output.durationMs,
            }),
          }),
          metadata: {
            sessionId,
            exitCode: output.exitCode,
            timedOut: output.timedOut,
            ...(output.process_id !== undefined
              ? { processId: output.process_id }
              : {}),
            durationMs: output.durationMs,
            ...(output.command_outcome === undefined ? {} : { commandOutcome: output.command_outcome }),
            ...(output.residual_processes_observed === true ? { residualProcessesObserved: true } : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
