import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import { shellWorkspaceMutationPermission } from "./shell-mutation-permission.js";
import { preflightShellWorkspaceWritePolicy } from "./shell-preflight.js";
import { foldDefaultSandboxPermission } from "./sandbox-permission-values.js";
import { polledShellScope, trackOwnShellChanges } from "./own-shell-changes.js";
import { UnifiedExecError, UnifiedExecUnavailableError } from "../../unified-exec/types.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import {
  execUnavailableToolResult,
  withAdmissionResumedNotice,
} from "./exec-unavailable.js";
import type { UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";
import { processOwnerIdFromToolArgs, execOwnerBindingFromToolArgs } from "../../unified-exec/process-ownership.js";
import {
  formatUnifiedExecToolContent,
  unifiedExecCodeModeResult,
  withSessionEndNotices,
} from "./exec-result-format.js";
import { buildRecoverableToolFailureMetadata } from "../result-metadata.js";
import {
  confirmedNoEffectDisposition,
  execEscalationGrant,
  LIGHT_DEFAULT_EXEC_YIELD_TIME_MS,
  runtimeSandboxForExec,
  SANDBOX_PERMISSION_INPUT_PROPERTIES,
} from "./exec-command.js";
import { SandboxExecutionError } from "../../sandbox/execution-broker.js";
import { createToolEffectDispositionEvidence } from "../effect-boundary.js";
import { readToolRuntimeContext } from "../runtimes/context.js";
import { execSandboxDenialNotice } from "./exec-sandbox-denial.js";
import { execNetworkFailureNotice } from "./exec-network-failure.js";
import { notifyExecEscalationDiscovery } from "../exec-session-discovery.js";

export interface WriteStdinToolConfig {
  readonly lightMode?: boolean;
  readonly cwd?: string;
  readonly allowedPaths?: readonly string[];
  readonly env?: Record<string, string>;
  readonly maxTimeoutMs?: number;
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
  /**
   * A sandbox notice on this result tells the model to retry the session's
   * exec_command with sandbox_permissions: present exec_command's full
   * schema on the next request.
   */
  readonly onEscalationAdvised?: () => void;
  /**
   * Whether a Light empty poll keeps waiting past its yield while the
   * session's command is still using CPU (`AGENC_EXEC_WAIT_WHILE_BUSY`,
   * tools/system/exec-wait-mode.ts; process manager `waitWhileBusy`).
   */
  readonly waitWhileBusy?: () => boolean;
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
  if (error instanceof UnifiedExecUnavailableError) {
    return execUnavailableToolResult(error, "tool:system.write-stdin:exec-unavailable");
  }
  if (error instanceof UnifiedExecError && error.code === "session_exited") {
    // Not a failure: the session ended earlier and the message says how. As
    // an ordinary result a stale poll never feeds the repeat refusal; its text
    // never changes, so a model that keeps polling is still stopped by the
    // behavioral backstop.
    return {
      content: error.message,
      metadata: { sessionExited: true },
      effectDisposition: confirmedNoEffectDisposition(
        "tool:system.write-stdin:session-exited",
        error.message,
      ),
    };
  }
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

/**
 * Whether this poll may keep waiting while the command is busy (process
 * manager `waitWhileBusy`): a Light empty poll with no yield or one of at
 * least exec_command's default. A session started with `background: true`
 * keeps the yield of every poll (the manager knows how it started).
 */
function pollWaitsWhileBusy(
  config: WriteStdinToolConfig | undefined,
  chars: string,
  requestedYield: number | undefined,
): boolean {
  if (chars.length > 0 || config?.lightMode !== true || config.waitWhileBusy?.() !== true) return false;
  return requestedYield === undefined || requestedYield >= LIGHT_DEFAULT_EXEC_YIELD_TIME_MS;
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
      "Poll or write to a session exec_command left running, by session_id. chars='' polls any running session for new output; sending input needs a session started with tty=true and matching sandbox_permissions. Empty polls only read already-approved output and need no new sandbox escalation.",
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
    // under on_request. Empty polls only observe the already-admitted process.
    requiresApproval: true,
    checkPermissions(input) {
      const args = input as Record<string, unknown>;
      if (args.chars === undefined || args.chars === "") {
        return { behavior: "allow", updatedInput: args, decisionReason: { type: "other", reason: "polling output of an existing execution session" } };
      }
      return { behavior: "passthrough", message: "Writing input to an execution session requires approval." };
    },
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
    // Same fold as exec_command: a default-meaning sandbox_permissions value
    // is "default", never an escalation.
    reshapeModelArgs: foldDefaultSandboxPermission,
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "number",
          description: "session_id from exec_command.",
        },
        chars: {
          type: "string",
          description: "Input to send, with newlines for shell commands; empty to poll.",
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
            "For non-empty input, match the sandbox_permissions value the session was started with. Empty polls need no escalation.",
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
        const output = await trackOwnShellChanges(args, polledShellScope(args, sessionId, chars, config?.cwd ?? process.cwd(), runtimeSandbox), () => manager.writeStdin({
          ...(execOwnerBindingFromToolArgs(args as Record<string, unknown>) !== undefined
            ? { ownerBinding: execOwnerBindingFromToolArgs(args as Record<string, unknown>) } : {}),
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
          // An empty poll is a wait: while the command is still busy it waits
          // for the exit instead of returning for another poll. Input and a
          // poll asking for a yield shorter than exec_command's default keep
          // their yield, as exec_command does.
          ...(pollWaitsWhileBusy(config, chars, asNumber(args.yield_time_ms))
            ? { waitWhileBusy: true }
            : {}),
        }));
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
        const denial = execSandboxDenialNotice({
          output: execContent,
          exitCode: output.exitCode,
          sandboxApplied: output.sandboxApplied ?? runtimeSandbox !== undefined,
          session: runtimeContext?.invocation.session,
          escalation: execEscalationGrant(args, "with_approval"),
        });
        const networkEscalation = execEscalationGrant(args, "unavailable");
        const networkNotice = denial === null
          ? execNetworkFailureNotice({
              output: execContent,
              exitCode: output.exitCode,
              runtimeSandbox: output.sandboxApplied === false ? undefined : runtimeSandbox,
              escalation: networkEscalation,
            })
          : null;
        // The retry the notice asks for is the session's exec_command launch:
        // present that tool's sandbox_permissions on the next request.
        if (denial?.advisesEscalation === true || (networkNotice !== null && networkEscalation !== "unavailable")) {
          notifyExecEscalationDiscovery(args, config?.onEscalationAdvised);
        }
        const notice = denial?.notice ?? networkNotice;
        // Other background sessions of this conversation that ended since the
        // last exec-family result; this session's own exit is in the output.
        const endNotices = manager.takeSessionEndNotices?.({ ...(ownerId !== undefined ? { ownerId } : {}) });
        return {
          content: withAdmissionResumedNotice(
            withSessionEndNotices(
              notice === null ? execContent : `${execContent}\n\n${notice}`,
              endNotices,
            ),
            manager.takeAdmissionResumedNotice?.(),
            args as Record<string, unknown>,
          ),
          isError: isError || undefined,
          codeModeResult: {
            ...unifiedExecCodeModeResult(output, notice),
            ...(endNotices !== undefined && endNotices.length > 0 ? { ended_sessions: endNotices } : {}),
          },
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
