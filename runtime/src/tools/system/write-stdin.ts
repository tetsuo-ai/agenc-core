import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import {
  UnifiedExecError,
  UnifiedExecProcessManager,
  type UnifiedExecProcessManagerLike,
} from "../../unified-exec/index.js";
import {
  formatUnifiedExecToolContent,
  unifiedExecCodeModeResult,
} from "./exec-result-format.js";

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
      "Send input to a live AgenC PTY session created by exec_command with tty=true. Use session_id from the exec_command result. Pass chars='' to poll for more output.",
    metadata: {
      family: "terminal",
      source: "builtin",
      keywords: ["stdin", "pty", "terminal", "interactive", "session"],
      preferredProfiles: ["coding", "validation", "operator"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
    },
    requiresApproval: false,
    concurrencyClass: { kind: "background_terminal" },
    isReadOnly: false,
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
        return {
          content: safeStringify({
            error: "session_id must be a number",
          }),
          isError: true,
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
          return {
            content: safeStringify({
              error:
                workspaceWriteDecision.message ??
                "Shell workspace write policy blocked the input.",
            }),
            isError: true,
          };
        }
      }

      try {
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
        });
        const isError = output.exitCode !== null && output.exitCode !== 0;
        return {
          content: formatUnifiedExecToolContent(output),
          isError: isError || undefined,
          codeModeResult: unifiedExecCodeModeResult(output),
          metadata: {
            sessionId,
            ...(output.process_id !== undefined
              ? { processId: output.process_id }
              : {}),
            durationMs: output.durationMs,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
