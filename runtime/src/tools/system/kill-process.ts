/**
 * kill_process — the kill half of the background-shell trio
 * (exec_command run-in-background via yield_time_ms → write_stdin
 * chars:'' output polling → kill_process termination). Before this
 * tool existed a yielded background process could only be abandoned:
 * the model had no handle to stop a runaway command short of waiting
 * for the manager's hard timeout.
 */
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type { UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";
import { processOwnerIdFromToolArgs } from "../../unified-exec/process-ownership.js";
import { UnifiedExecError } from "../../unified-exec/types.js";

export interface KillProcessToolConfig {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly maxTimeoutMs?: number;
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function createKillProcessTool(config?: KillProcessToolConfig): Tool {
  const manager =
    config?.unifiedExecManager ??
    new UnifiedExecProcessManager({
      cwd: config?.cwd,
      env: config?.env,
      maxTimeoutMs: config?.maxTimeoutMs,
    });

  return {
    name: "kill_process",
    description:
      "Terminate a background process started by exec_command, by its session_id. Reports terminated=false when the process already exited (killing a finished process is a benign race, not an error).",
    metadata: {
      family: "terminal",
      source: "builtin",
      keywords: ["kill", "terminate", "process", "background", "session"],
      preferredProfiles: ["coding", "validation", "operator"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
      /**
       * Audited per the ToolMetadata.virtualNoFsWrites contract: execute()
       * below validates `session_id` as a number, rejects the removed
       * `process_id` alias, and calls `terminateProcess` — it sends a signal
       * and writes no file. The schema is `{session_id: number}` with
       * `additionalProperties: false`, so no path argument exists for the
       * model to steer, and this tool neither executes shell nor runs
       * arbitrary code. Without the exemption the sandbox classified it as a
       * mutating tool with indeterminate write targets and denied every call
       * ("sandbox workspace_write could not verify write targets for
       * kill_process"), leaving a model unable to stop a background process
       * it had started. Which process may be signalled stays enforced where
       * it belongs, by the ownership check in `terminateProcess`.
       */
      virtualNoFsWrites: true,
    },
    // TOOL-02 / TOOL-11: kill is side-effecting and must not opt out of approval.
    requiresApproval: true,
    concurrencyClass: { kind: "background_terminal" },
    isReadOnly: false,
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
            "The session_id returned by exec_command for the process to terminate.",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      if (Object.prototype.hasOwnProperty.call(args, "process_id")) {
        return {
          content: safeStringify({ error: "unknown field `process_id`" }),
          isError: true,
        };
      }
      const sessionId = asNumber(args.session_id);
      if (sessionId === undefined) {
        return {
          content: safeStringify({ error: "session_id must be a number" }),
          isError: true,
        };
      }
      if (manager.terminateProcess === undefined) {
        return {
          content: safeStringify({
            error: "process termination is not supported by this runtime",
          }),
          isError: true,
        };
      }
      const ownerId = processOwnerIdFromToolArgs(args);
      try {
        const outcome = manager.terminateProcess({
          processId: sessionId,
          ...(ownerId !== undefined ? { ownerId } : {}),
        });
        return {
          content: safeStringify({
            session_id: sessionId,
            terminated: outcome.terminated,
            ...(outcome.terminated
              ? {}
              : {
                  note: "no live process with this id (already exited or unknown)",
                }),
          }),
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: safeStringify({
            error: message,
            ...(error instanceof UnifiedExecError
              ? { code: error.code }
              : {}),
          }),
          isError: true,
        };
      }
    },
  };
}
