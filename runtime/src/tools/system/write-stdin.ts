import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import { UnifiedExecError } from "../../unified-exec/types.js";
import {
  UnifiedExecProcessExitedBeforeWriteError,
  UnifiedExecProcessManager,
} from "../../unified-exec/process-manager.js";
import type { UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";
import { processOwnerIdFromToolArgs } from "../../unified-exec/process-ownership.js";
import { SandboxExecutionError } from "../../sandbox/execution-broker.js";
import {
  formatUnifiedExecToolContent,
  unifiedExecCodeModeResult,
} from "./exec-result-format.js";
import { buildRecoverableToolFailureMetadata } from "../result-metadata.js";
import { createToolEffectDispositionEvidence } from "../effect-boundary.js";
import { runtimeSandboxForExec } from "./exec-command.js";

export interface WriteStdinToolConfig {
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

function confirmedNoEffectDisposition(
  evidenceRef: string,
  evidenceMaterial: string,
) {
  return createToolEffectDispositionEvidence({
    disposition: "confirmed_no_effect",
    evidenceKind: "boundary_not_crossed",
    evidenceRef,
    evidenceMaterial,
  });
}

function isDeterministicPreDispatchRefusal(error: unknown): boolean {
  if (error instanceof SandboxExecutionError) return true;
  if (!(error instanceof UnifiedExecError)) return false;
  switch (error.code) {
    case "unknown_process":
    case "stdin_closed":
    case "owner_denied":
      return true;
    case "write_stdin":
      // The manager uses the same broad code for a sandbox-profile refusal
      // (before touching stdin) and an actual write failure (after dispatch
      // may have started). Only the typed, stable pre-dispatch refusal is
      // safe to settle as no-effect; the latter must remain unknown.
      return error.message.includes(
        "requires an existing session with a compatible sandbox profile",
      );
    default:
      return false;
  }
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: safeStringify({
      error: message,
      ...(error instanceof UnifiedExecError ? { code: error.code } : {}),
    }),
    isError: true,
    ...(isDeterministicPreDispatchRefusal(error)
      ? {
          effectDisposition: confirmedNoEffectDisposition(
            "tool:system.write-stdin:pre-dispatch-refusal",
            message,
          ),
        }
      : {}),
  };
}

function processObservationDisposition(
  sessionId: number,
  chars: string,
  output: Awaited<ReturnType<UnifiedExecProcessManagerLike["writeStdin"]>>,
  evidenceRef?: string,
  inputAccepted: boolean | null = chars.length > 0 ? true : null,
) {
  const stillAlive =
    output.exitCode === null && output.process_id !== undefined;
  return createToolEffectDispositionEvidence({
    disposition: "confirmed_committed",
    evidenceKind: "provider_receipt",
    evidenceRef:
      evidenceRef ??
      (stillAlive
        ? "tool:system.write-stdin:process-yield"
        : "tool:system.write-stdin:process-exit"),
    evidenceMaterial: JSON.stringify({
      sessionId,
      inputBytes: Buffer.byteLength(chars, "utf8"),
      inputAccepted,
      exitCode: output.exitCode,
      processId: output.process_id ?? null,
      timedOut: output.timedOut,
      durationMs: output.durationMs,
    }),
  });
}

function observedExitBeforeWriteResult(
  error: UnifiedExecProcessExitedBeforeWriteError,
  sessionId: number,
  chars: string,
): ToolResult {
  const output = error.observation;
  return {
    content: `${formatUnifiedExecToolContent(output)}\n\n[write_stdin rejected: ${error.message}]`,
    isError: true,
    codeModeResult: {
      ...unifiedExecCodeModeResult(output),
      error: error.message,
      code: error.code,
    },
    effectDisposition: processObservationDisposition(
      sessionId,
      chars,
      output,
      "tool:system.write-stdin:process-exit-before-input",
      false,
    ),
    metadata: {
      sessionId,
      processExitedBeforeInput: true,
      durationMs: output.durationMs,
      timedOut: output.timedOut,
      truncated: output.truncated,
      originalTokenCount: output.original_token_count,
    },
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
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "number",
          description:
            "The session_id returned by exec_command for a still-running process.",
        },
        process_id: {
          type: "number",
          description:
            "Compatibility alias for session_id. Prefer session_id.",
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
      },
      anyOf: [{ required: ["session_id"] }, { required: ["process_id"] }],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as Record<string, unknown> & ToolExecutionInjectedArgs;
      const sessionId = asNumber(args.session_id) ?? asNumber(args.process_id);
      if (sessionId === undefined) {
        const message = "session_id must be a number";
        return {
          content: safeStringify({
            error: message,
          }),
          isError: true,
          effectDisposition: confirmedNoEffectDisposition(
            "tool:system.write-stdin:input-validation",
            message,
          ),
        };
      }
      const chars = asString(args.chars) ?? "";
      if (chars.trim().length > 0) {
        const workspaceWriteDecision = classifyShellWorkspaceWritePolicy({
          toolName: "write_stdin",
          args: { command: chars, cwd: config?.cwd },
          workspaceRoot: config?.cwd ?? config?.allowedPaths?.[0],
        });
        if (workspaceWriteDecision.blocked) {
          const message =
            workspaceWriteDecision.message ??
            "Shell workspace write policy blocked the input.";
          return {
            content: safeStringify({ error: message }),
            isError: true,
            metadata: buildRecoverableToolFailureMetadata(
              "shell_workspace_write_policy",
            ),
            effectDisposition: confirmedNoEffectDisposition(
              "tool:system.write-stdin:workspace-write-policy",
              message,
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
          (output.exitCode !== null && output.exitCode !== 0) ||
          (output.exitCode === null && !stillAlive);
        return {
          content: formatUnifiedExecToolContent(output),
          isError: isError || undefined,
          codeModeResult: unifiedExecCodeModeResult(output),
          effectDisposition: processObservationDisposition(
            sessionId,
            chars,
            output,
          ),
          metadata: {
            sessionId,
            ...(output.process_id !== undefined
              ? { processId: output.process_id }
              : {}),
            durationMs: output.durationMs,
          },
        };
      } catch (error) {
        if (error instanceof UnifiedExecProcessExitedBeforeWriteError) {
          return observedExitBeforeWriteResult(error, sessionId, chars);
        }
        return errorResult(error);
      }
    },
  };
}
