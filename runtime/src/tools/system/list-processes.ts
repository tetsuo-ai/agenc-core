/**
 * list_processes — the owner-scoped inventory of yielded exec_command
 * sessions (#2477). An agent that has to recover from hung or leftover
 * background work asks the manager which of *its own* sessions are still
 * live and stops them by session_id. This replaces the failure mode observed
 * on Terminal-Bench, where a model searched `/proc/*\/cmdline` for task
 * filenames and killed the AgenC CLI and its process brokers along with the
 * work: managed identity is the recovery path, not global command-line
 * matching.
 *
 * This is inventory, not isolation. In full-access mode arbitrary shell or
 * Python the model runs can still signal any same-UID process; see
 * docs/reference/tools-permissions-sandbox.md, "Recovering background work".
 */
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type {
  OwnedProcessView,
  UnifiedExecProcessManagerLike,
} from "../../unified-exec/types.js";
import { processOwnerIdFromToolArgs, isLiveOwnedProcess } from "../../unified-exec/process-ownership.js";

export interface ListProcessesToolConfig {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly maxTimeoutMs?: number;
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
}

const LIST_PROCESSES_SCOPE_NOTE =
  "Only sessions this conversation started with exec_command are listed; another conversation's sessions and detached services (detach: true) are not. Stop live sessions with kill_process by session_id or all=true rather than matching command text in the process table, which also selects AgenC's own CLI and process brokers.";

interface ListProcessesSessionEntry {
  readonly session_id: number;
  readonly status: OwnedProcessView["status"];
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  readonly started_at: string;
  readonly ended_at?: string;
  readonly exit_code?: number;
}

function formatOwnedProcessView(view: OwnedProcessView): ListProcessesSessionEntry {
  return {
    session_id: view.sessionId,
    status: view.status,
    command: view.command,
    cwd: view.cwd,
    tty: view.tty,
    started_at: new Date(view.startedAt).toISOString(),
    ...(view.endedAt !== undefined
      ? { ended_at: new Date(view.endedAt).toISOString() }
      : {}),
    ...(view.exitCode !== undefined ? { exit_code: view.exitCode } : {}),
  };
}

export function createListProcessesTool(config?: ListProcessesToolConfig): Tool {
  const manager =
    config?.unifiedExecManager ??
    new UnifiedExecProcessManager({
      cwd: config?.cwd,
      env: config?.env,
      maxTimeoutMs: config?.maxTimeoutMs,
    });

  return {
    name: "list_processes",
    description:
      "List the background sessions this conversation started with exec_command (those that returned a session_id) with their status: running, stopping, completed, failed, or killed. Use it to find which of your sessions are still live before stopping them with kill_process, for example after kill_process reported terminated=false for a session that had already exited. Scoped to this conversation: it never shows another conversation's processes and never scans the process table.",
    metadata: {
      family: "terminal",
      source: "builtin",
      keywords: ["list", "processes", "background", "session", "running", "cleanup"],
      preferredProfiles: ["coding", "validation", "operator"],
      hiddenByDefault: false,
      mutating: false,
      deferred: false,
    },
    requiresApproval: false,
    isReadOnly: true,
    recoveryCategory: "idempotent",
    supportsParallelToolCalls: true,
    isConcurrencySafe: () => true,
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["live", "all"],
          description:
            "live (default): sessions still running or stopping. all: also include exited sessions whose final output has not been collected yet.",
        },
      },
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const status = args.status ?? "live";
      if (status !== "live" && status !== "all") {
        return {
          content: safeStringify({ error: "status must be 'live' or 'all'" }),
          isError: true,
        };
      }
      if (manager.listOwnedProcesses === undefined) {
        return {
          content: safeStringify({
            error: "process inventory is not supported by this runtime",
          }),
          isError: true,
        };
      }
      const ownerId = processOwnerIdFromToolArgs(args);
      const views = manager.listOwnedProcesses({
        ...(ownerId !== undefined ? { ownerId } : {}),
      });
      const selected =
        status === "live"
          ? views.filter(isLiveOwnedProcess)
          : views;
      return {
        content: safeStringify({
          sessions: selected.map(formatOwnedProcessView),
          live_count: views.filter(isLiveOwnedProcess).length,
          note: LIST_PROCESSES_SCOPE_NOTE,
        }),
      };
    },
  };
}
