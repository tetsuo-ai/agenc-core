/**
 * kill_process — the kill half of the background-shell trio
 * (exec_command run-in-background via yield_time_ms → write_stdin
 * chars:'' output polling → kill_process termination). Before this
 * tool existed a yielded background process could only be abandoned:
 * the model had no handle to stop a runaway command short of waiting
 * for the manager's hard timeout.
 *
 * Recovery through owned identity (#2477): every result also names the
 * caller's own sessions that are still live, and `session_ids` / `all`
 * stop several at once through the manager's ownership checks. A
 * `terminated:false` therefore points at the remaining owned work instead
 * of inviting a `/proc/*\/cmdline` filename scan — the scan that selected
 * and killed the AgenC CLI and its process brokers in a Terminal-Bench run.
 */
import type { Tool, ToolResult } from "../types.js";
import { validationErrorToolResult } from "../results.js";
import { createToolEffectDispositionEvidence } from "../effect-boundary.js";
import { safeStringify } from "../types.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type {
  TerminateOwnedProcessesOutcome,
  UnifiedExecProcessManagerLike,
} from "../../unified-exec/types.js";
import { processOwnerIdFromToolArgs, isLiveOwnedProcess } from "../../unified-exec/process-ownership.js";
import { UnifiedExecError } from "../../unified-exec/types.js";

export interface KillProcessToolConfig {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly maxTimeoutMs?: number;
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
}

/** Guidance attached whenever owned live sessions remain after a kill. */
const REMAINING_OWNED_WORK_NOTE =
  "these are the sessions this conversation started that are still running; stop them by session_id or with all=true. Do not search the process table for task filenames or command text: that also matches AgenC's own CLI and process brokers.";

/**
 * A signal returns before the process exits, so a session killed a moment
 * ago is still live in the result. Naming it as stopping keeps the report
 * honest (its exit is not observed yet) without reading as a failed kill.
 * The wording says a stop was requested: the manager records the request
 * even when it refuses to signal an unsafe pid.
 */
const STOPPING_SESSIONS_NOTE =
  "a stop was requested for these sessions and their exit is not confirmed yet. Do not signal them again; check list_processes shortly.";

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.map(asNumber);
  return numbers.every((item): item is number => item !== undefined)
    ? numbers
    : undefined;
}

type KillSelection =
  | { readonly kind: "one"; readonly sessionId: number }
  | { readonly kind: "many"; readonly sessionIds: readonly number[] }
  | { readonly kind: "all" };

/**
 * Models that fill every optional field send the empty value of each selector
 * they did not mean: `session_ids: []`, `all: false`, and `session_id: 0`.
 * None of those can select anything (session ids start at 1), so they count as
 * absent instead of as a second selector. Any other value still counts, so a
 * call that names two real targets is refused as before.
 */
function selectorGiven(
  args: Record<string, unknown>,
  key: "session_id" | "session_ids" | "all",
): boolean {
  const value = args[key];
  if (value === undefined) return false;
  if (key === "session_id") return value !== 0;
  if (key === "session_ids") return !(Array.isArray(value) && value.length === 0);
  return value !== false;
}

function selectTargets(
  args: Record<string, unknown>,
): KillSelection | { readonly error: string } {
  const sessionIdGiven = selectorGiven(args, "session_id");
  const sessionIdsGiven = selectorGiven(args, "session_ids");
  const allGiven = selectorGiven(args, "all");
  const provided = [sessionIdGiven, sessionIdsGiven, allGiven].filter(Boolean)
    .length;
  if (provided === 0) {
    return {
      error:
        "session_id must be a number returned by exec_command (or pass session_ids, or all=true)",
    };
  }
  if (provided > 1) {
    return {
      error: "pass exactly one of session_id, session_ids, or all=true",
    };
  }
  if (sessionIdGiven) {
    const sessionId = asNumber(args.session_id);
    return sessionId === undefined
      ? { error: "session_id must be a number" }
      : { kind: "one", sessionId };
  }
  if (sessionIdsGiven) {
    const sessionIds = asNumberArray(args.session_ids);
    if (sessionIds === undefined || sessionIds.length === 0) {
      return { error: "session_ids must be a non-empty array of numbers" };
    }
    return { kind: "many", sessionIds };
  }
  return args.all === true
    ? { kind: "all" }
    : { error: "all must be true to stop every owned session" };
}

export function createKillProcessTool(config?: KillProcessToolConfig): Tool {
  const manager =
    config?.unifiedExecManager ??
    new UnifiedExecProcessManager({
      cwd: config?.cwd,
      env: config?.env,
      maxTimeoutMs: config?.maxTimeoutMs,
    });

  /** Owned sessions still running after this call, or undefined when the manager cannot say. */
  const ownedLiveSessions = (ownerId: string | undefined): number[] | undefined =>
    manager.listOwnedProcesses
      ?.({ ...(ownerId !== undefined ? { ownerId } : {}) })
      .filter(isLiveOwnedProcess)
      .map((view) => view.sessionId);

  /** Owned sessions signalled to stop whose exit is not observed yet. */
  const ownedStoppingSessions = (ownerId: string | undefined): number[] =>
    manager.listOwnedProcesses
      ?.({ ...(ownerId !== undefined ? { ownerId } : {}) })
      .filter((view) => view.status === "stopping")
      .map((view) => view.sessionId) ?? [];

  return {
    name: "kill_process",
    description:
      "Terminate background processes started by exec_command in this conversation. Pass session_id for one, session_ids for several, or all=true to stop every session this conversation still has running. Reports terminated=false for a session that already exited (a benign race, not an error) and always lists the owned sessions that remain live, so cleanup is driven by session ids. Never clean up by scanning the process table for task filenames or command text: such a match also selects AgenC's own CLI and process brokers. Another conversation's sessions are refused.",
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
       * below validates `session_id` / `session_ids` / `all`, rejects the
       * removed `process_id` alias, and calls `terminateProcess` or
       * `terminateOwnedProcesses` — each sends a signal and writes no file.
       * The schema carries only numeric ids and a boolean with
       * `additionalProperties: false`, so no path argument exists for the
       * model to steer, and this tool neither executes shell nor runs
       * arbitrary code. Without the exemption the sandbox classified it as a
       * mutating tool with indeterminate write targets and denied every call
       * ("sandbox workspace_write could not verify write targets for
       * kill_process"), leaving a model unable to stop a background process
       * it had started. Which process may be signalled stays enforced where
       * it belongs, by the ownership checks in the manager.
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
        session_ids: {
          type: "array",
          items: { type: "number" },
          description:
            "Several session_ids to terminate together. Every id is ownership-checked before any signal is sent.",
        },
        all: {
          type: "boolean",
          description:
            "Stop every background session this conversation started that is still running. Never touches another conversation's sessions.",
        },
      },
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      // Refusals before any signal is sent carry a confirmed no-effect
      // disposition; a bare error from a side-effecting tool gates the
      // session behind /resolve (#2190).
      const refuse = (error: string): ToolResult => ({
        ...validationErrorToolResult("tool:system.kill-process:validation", error),
        content: safeStringify({ error }),
      });
      if (Object.prototype.hasOwnProperty.call(args, "process_id")) {
        return refuse("unknown field `process_id`");
      }
      const selection = selectTargets(args);
      if ("error" in selection) return refuse(selection.error);
      if (manager.terminateProcess === undefined) {
        return refuse("process termination is not supported by this runtime");
      }
      if (selection.kind !== "one" && manager.terminateOwnedProcesses === undefined) {
        return refuse("bulk process termination is not supported by this runtime");
      }
      const ownerId = processOwnerIdFromToolArgs(args);
      const ownerArg = ownerId !== undefined ? { ownerId } : {};
      try {
        let body: Record<string, unknown>;
        switch (selection.kind) {
          case "one": {
            const outcome = manager.terminateProcess({
              processId: selection.sessionId,
              ...ownerArg,
            });
            body = {
              session_id: selection.sessionId,
              terminated: outcome.terminated,
              ...(outcome.terminated
                ? {}
                : {
                    note: "no live process with this id (already exited or unknown)",
                  }),
            };
            break;
          }
          case "many": {
            const outcome: TerminateOwnedProcessesOutcome =
              manager.terminateOwnedProcesses!({
                processIds: selection.sessionIds,
                ...ownerArg,
              });
            body = {
              session_ids: selection.sessionIds,
              results: outcome.results.map((result) => ({
                session_id: result.sessionId,
                terminated: result.terminated,
              })),
            };
            break;
          }
          case "all": {
            const outcome: TerminateOwnedProcessesOutcome =
              manager.terminateOwnedProcesses!({ ...ownerArg });
            body = {
              all: true,
              results: outcome.results.map((result) => ({
                session_id: result.sessionId,
                terminated: result.terminated,
              })),
              ...(outcome.results.length === 0
                ? { note: "no live background session owned by this conversation" }
                : {}),
            };
            break;
          }
          default: {
            const exhaustive: never = selection;
            return exhaustive;
          }
        }
        const remaining = ownedLiveSessions(ownerId);
        const stopping = remaining === undefined ? [] : ownedStoppingSessions(ownerId);
        return {
          content: safeStringify({
            ...body,
            ...(remaining !== undefined
              ? {
                  owned_live_sessions: remaining,
                  ...(remaining.length > 0
                    ? { owned_live_sessions_note: REMAINING_OWNED_WORK_NOTE }
                    : {}),
                  ...(stopping.length > 0
                    ? { stopping_sessions: stopping, stopping_sessions_note: STOPPING_SESSIONS_NOTE }
                    : {}),
                }
              : {}),
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
          // The manager refuses (unknown owner, denied access) before it
          // signals the process.
          ...(error instanceof UnifiedExecError
            ? {
                effectDisposition: createToolEffectDispositionEvidence({
                  disposition: "confirmed_no_effect",
                  evidenceKind: "boundary_not_crossed",
                  evidenceRef: "tool:system.kill-process:refused",
                  evidenceMaterial: message,
                }),
              }
            : {}),
        };
      }
    },
  };
}
