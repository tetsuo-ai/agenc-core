/**
 * `Monitor` — port of the donor `MonitorTool`.
 *
 * Verbatim model-facing prompt from donor `MonitorTool.ts:90`. The
 * tool spawns a shell command in the background and streams its stdout
 * line-by-line as `tool_progress` events that the runtime delivers to
 * the model as notifications. For one-shot "wait until done" commands
 * the model uses `exec_command` with a short `yield_time_ms` instead.
 *
 * Implementation contract:
 *   - Schema: `{ command: string, description: string }` (verbatim).
 *   - Returns: `{ taskId, outputFile }` text confirmation matching
 *     donor `mapToolResultToToolResultBlockParam` content.
 *   - Streams output through AgenC's existing `unifiedExecManager`
 *     `tool_progress` event channel — the same path `exec_command`
 *     uses for live stdout/stderr chunks. The foreground stream yields
 *     after about 30 seconds, while the process itself has no implicit
 *     runtime deadline.
 *
 * @module
 */

import type {
  Tool,
  ToolExecutionInjectedArgs,
  ToolResult,
} from "../types.js";
import type { UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";
import { processOwnerIdFromToolArgs } from "../../unified-exec/process-ownership.js";
import { nonEmptyString as asNonEmptyString } from "../../utils/stringUtils.js";
import { runtimeSandboxForExec } from "./exec-command.js";

const MONITOR_INITIAL_YIELD_MS = 30_000;

/**
 * Verbatim port of donor `MonitorTool.prompt()`
 * (`src/tools/MonitorTool/MonitorTool.ts:89-91`). Adapted only to
 * mention AgenC's `exec_command`'s `yield_time_ms` instead of
 * AgenC's `Bash` `run_in_background`, since that's the AgenC
 * primitive the model already knows.
 */
const MONITOR_DESCRIPTION = `Execute a shell command in the background and stream its stdout line-by-line as notifications for up to ~30 seconds. After that streaming window the command keeps running, but new output is NOT pushed automatically — poll for more with write_stdin(session_id, "") (an empty write) until it exits. Use this for monitoring logs, watching build output, or observing long-running processes. For one-shot "wait until done" commands, prefer exec_command with a short yield_time_ms instead.`;

interface MonitorToolInput extends ToolExecutionInjectedArgs {
  readonly command?: unknown;
  readonly description?: unknown;
}

export interface MonitorToolConfig {
  readonly cwd: string;
  readonly unifiedExecManager: UnifiedExecProcessManagerLike;
}

export function createMonitorTool(config: MonitorToolConfig): Tool {
  return {
    name: "Monitor",
    description: MONITOR_DESCRIPTION,
    metadata: {
      family: "terminal",
      source: "builtin",
      keywords: ["monitor", "stream", "tail", "watch", "follow", "logs"],
      preferredProfiles: ["coding", "general", "operator"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
    },
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    // Monitor owns its foreground yield semantics. The generic executor
    // must not turn that yield window into a process deadline.
    timeoutBehavior: "tool",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to run and monitor",
        },
        description: {
          type: "string",
          description:
            "Clear, concise description of what this command does in active voice.",
        },
      },
      required: ["command", "description"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as MonitorToolInput;
      const command = asNonEmptyString(args.command);
      const description = asNonEmptyString(args.description);
      if (!command) {
        return {
          content: "command must be a non-empty string",
          isError: true,
        };
      }
      if (!description) {
        return {
          content:
            "description must be a non-empty string (active-voice summary of the command)",
          isError: true,
        };
      }

      const startedAt = Date.now();
      try {
        // Drive through unifiedExecManager exactly the same way
        // exec_command does — that's how the runtime already streams
        // line-by-line tool_progress chunks. A bounded initial yield
        // returns a process id; the command remains alive without an
        // implicit hard timeout and can be polled or explicitly stopped.
        const ownerId = processOwnerIdFromToolArgs(
          rawArgs as Record<string, unknown>,
        );
        const runtimeSandbox = runtimeSandboxForExec(
          rawArgs,
          config.cwd,
          "background",
        );
        const output = await config.unifiedExecManager.execCommand({
          cmd: command,
          workdir: config.cwd,
          tty: false,
          yield_time_ms: MONITOR_INITIAL_YIELD_MS,
          ...(args.__abortSignal !== undefined
            ? { __abortSignal: args.__abortSignal }
            : {}),
          ...(args.__onProgress !== undefined
            ? { __onProgress: args.__onProgress }
            : {}),
          ...(ownerId !== undefined ? { ownerId } : {}),
          ...(runtimeSandbox !== undefined ? { runtimeSandbox } : {}),
        });

        const taskId =
          output.process_id !== undefined
            ? `monitor-${output.process_id}`
            : `monitor-${startedAt.toString(36)}`;
        // AgenC has no on-disk task-output mirror (AgenC's
        // `getTaskOutputPath`), but the live stream is delivered via
        // tool_progress events which the model already consumes.
        // Use a synthetic agenc:// URI so the result shape matches
        // upstream without inventing an unused file path.
        const outputFile = `agenc://exec/${taskId}/output`;

        // Verbatim port of AgenC
        // `mapToolResultToToolResultBlockParam` content
        // (`MonitorTool.ts:140-145`), with the stop instruction phrased
        // around AgenC's current tool surface.
        const content =
          `Monitor task started with ID: ${taskId}. ` +
          `Output is being streamed to: ${outputFile}. ` +
          `You will receive notifications as new output lines appear (~1s polling). ` +
          `When the command exits or you want to stop monitoring, the task ends automatically; ` +
          `to interrupt sooner, abort the turn.`;

        return {
          content,
          metadata: {
            taskId,
            outputFile,
            command,
            description,
            cwd: config.cwd,
            ...(output.process_id !== undefined
              ? { processId: output.process_id, sessionId: output.process_id }
              : {}),
            exitCode: output.exitCode,
            durationMs: output.durationMs,
            stdout: output.stdout,
            stderr: output.stderr,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Monitor failed to start: ${message}`,
          isError: true,
          metadata: {
            command,
            description,
            cwd: config.cwd,
            durationMs: Date.now() - startedAt,
          },
        };
      }
    },
  };
}
