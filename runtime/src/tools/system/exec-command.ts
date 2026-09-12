import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { Tool, ToolExecutionInjectedArgs, ToolPreflightFailure, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import {
  shellAdditionalWriteRoots,
  shellBypassesApprovalsAndSandbox,
  shellWorkspaceMutationPermission,
} from "./shell-mutation-permission.js";
import { preflightShellWorkspaceWritePolicy } from "./shell-preflight.js";
import type { BashToolConfig } from "./types.js";
import { UnifiedExecError } from "../../unified-exec/types.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type {
  ExecCommandToolOutput,
  UnifiedExecProcessManagerLike,
  UnifiedExecRuntimeSandbox,
} from "../../unified-exec/types.js";
import { processOwnerIdFromToolArgs } from "../../unified-exec/process-ownership.js";
import type {
  NetworkSandboxPolicy,
  WindowsSandboxLevel,
} from "../../sandbox/engine/index.js";
import type {
  BlockedRequestObserver,
  NetworkPolicyDecider,
} from "../../sandbox/network-policy.js";
import {
  missingSandboxExecutionBoundary,
  readSandboxExecutionBroker,
  readSandboxExecutionSurface,
  SandboxExecutionError,
  type SandboxExecutionSurface,
} from "../../sandbox/execution-broker.js";
import { isSearchOrReadBashCommand } from "../../utils/bash/commands.js";
import {
  formatUnifiedExecToolContent,
  unifiedExecCodeModeResult,
} from "./exec-result-format.js";
import { buildRecoverableToolFailureMetadata } from "../result-metadata.js";
import { nonEmptyString as asString } from "../../utils/stringUtils.js";
import { createToolEffectDispositionEvidence } from "../effect-boundary.js";
import { readToolRuntimeContext } from "../runtimes/context.js";
import {
  execSandboxDenialNotice,
  sandboxEscalationAvailable,
} from "./exec-sandbox-denial.js";
import { parseSandboxPermissionsArgs } from "../../sandbox/escalation/sandboxing.js";
import { readReadOnlyInspectionInvocation } from "../../permissions/readonly-inspection.js";
import {
  permissionProfileForRuntimeContext,
  runtimePlatformSandboxStatus,
  sandboxModeRequiresPlatformIsolation,
} from "../runtimes/sandboxing.js";

export interface ExecCommandToolConfig extends BashToolConfig {
  readonly allowedPaths?: readonly string[];
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
}

const PLAIN_INTERACTIVE_SHELL_RE =
  /^\s*(?:(?:\/[\w.-]+)+\/)?(?:bash|dash|ksh|sh|zsh)(?:\s+-[A-Za-z]*[il][A-Za-z]*)*\s*$/u;
const MCP_TOOL_NAME_RE = /\bmcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+\b/u;
const DIRECT_MCP_TOOL_COMMAND_RE =
  /^\s*mcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+(?:\s|$|\()/u;

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

function isMcpShellPlaceholderCommand(command: string): boolean {
  const trimmed = command.trim();
  if (DIRECT_MCP_TOOL_COMMAND_RE.test(trimmed)) return true;
  if (/\battempting\s+direct\s+mcp\s+call\b/iu.test(trimmed)) return true;
  if (/\bdirect\s+(?:mcp\s+)?call\s+simulation\b/iu.test(trimmed)) {
    return true;
  }
  if (
    /\bmcp\b/iu.test(trimmed) &&
    /\b(simulat(?:e|ed|ion)|fake|placeholder|stand[- ]?in|actual\s+mcp\s+tool|need\s+to\s+call)\b/iu.test(trimmed)
  ) {
    return true;
  }
  return (
    MCP_TOOL_NAME_RE.test(trimmed) &&
    /\b(simulat(?:e|ed|ion)|fake|placeholder|stand[- ]?in|direct)\b/iu.test(trimmed)
  );
}

/**
 * The sandbox permission fields a tool takes when it may need a wider sandbox
 * than the turn's default: exec_command for the command it starts, write_stdin
 * for a session exec_command started that way. The orchestrator reads them
 * from any tool's arguments.
 */
export const SANDBOX_PERMISSION_INPUT_PROPERTIES = {
  sandbox_permissions: {
    // Only the three documented modes. The former `{type:"object"}`
    // alternative invited a shape no parser accepted, so a model could
    // send an escalation request that was discarded without a word.
    type: "string",
    enum: ["default", "require_escalated", "with_additional_permissions"],
    description:
      "Sandbox escalation mode. Scoped permissions go in additional_permissions.",
  },
  additional_permissions: {
    type: "object",
    properties: {
      network: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        additionalProperties: false,
      },
      file_system: {
        type: "object",
        properties: {
          read: { type: "array", items: { type: "string" } },
          write: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
    description:
      'Scoped permissions to request alongside sandbox_permissions "with_additional_permissions".',
  },
  justification: {
    type: "string",
    description: "Why elevated execution is needed, when applicable.",
  },
} as const;

export function runtimeSandboxForExec(
  args: Record<string, unknown>,
  fallbackCwd: string,
  surface?: SandboxExecutionSurface,
): UnifiedExecRuntimeSandbox | undefined {
  const executionSurface = surface ??
    readSandboxExecutionSurface(args) ??
    "tool";
  const context = readToolRuntimeContext(args);
  if (context === undefined) {
    const broker = readSandboxExecutionBroker(args);
    if (broker === undefined) {
      throw missingSandboxExecutionBoundary(executionSurface);
    }
    return broker.runtimeSandbox(executionSurface);
  }
  if (
    !sandboxModeRequiresPlatformIsolation(context.sandboxMode)
  ) {
    return undefined;
  }
  const platformSandbox = runtimePlatformSandboxStatus(context);
  if (!platformSandbox.available) {
    throw new SandboxExecutionError({
      code: "sandbox_required_unavailable",
      surface: executionSurface,
      status: {
        kind: "unavailable",
        mode: context.sandboxMode,
        platform: process.platform,
        reason: platformSandbox.reason ?? "platform sandbox is unavailable",
        remediation:
          "Run `agenc doctor`; configure a trusted sandbox helper or select danger-full-access explicitly.",
        ...(platformSandbox.agencLinuxSandboxExe !== undefined
          ? { helperPath: platformSandbox.agencLinuxSandboxExe }
          : {}),
      },
    });
  }
  const turn = context.invocation.turn as {
    readonly agencLinuxSandboxExe?: unknown;
    readonly config?: {
      readonly agencLinuxSandboxExe?: unknown;
      readonly features?: unknown;
      readonly permissions?: {
        readonly windowsSandboxPrivateDesktop?: unknown;
      };
      readonly sandboxAllowGpu?: unknown;
    };
    readonly features?: unknown;
    readonly network?: unknown;
    readonly networkSandboxPolicy?: unknown;
    readonly cwd?: unknown;
    readonly windowsSandboxLevel?: unknown;
    readonly windowsSandboxPrivateDesktop?: unknown;
  };
  const sandboxPolicyCwd = resolve(
    stringValue(turn.cwd) ?? fallbackCwd,
  );
  const sessionTempRoot =
    context.invocation.session.services.runtimeOptions.sessionTempRoot;
  if (sessionTempRoot === undefined) {
    throw new SandboxExecutionError({
      code: "sandbox_surface_uncovered",
      surface: executionSurface,
      status: {
        kind: "unavailable",
        mode: context.sandboxMode,
        platform: process.platform,
        reason:
          "authenticated runtime session has no captured temp-root authority",
        remediation: "Create the session through the canonical runtime ingress.",
      },
    });
  }
  const network = networkPolicy(turn.networkSandboxPolicy);
  const networkInterfaces = networkPolicyInterfaces(turn.network);
  return {
    permissionProfile: permissionProfileForRuntimeContext(context, {
      cwd: sandboxPolicyCwd,
      ...(network !== undefined ? { network } : {}),
    }),
    ...(context.additionalPermissions !== undefined
      ? { additionalPermissions: context.additionalPermissions }
      : {}),
    sandboxPolicyCwd,
    sessionTempRoot,
    preference: "require",
    ...(booleanValue(turn.config?.sandboxAllowGpu) === true
      ? { allowGpu: true }
      : {}),
    windowsSandboxLevel: windowsSandboxLevel(turn.windowsSandboxLevel),
    windowsSandboxPrivateDesktop: booleanValue(
      turn.windowsSandboxPrivateDesktop,
    ) ?? booleanValue(turn.config?.permissions?.windowsSandboxPrivateDesktop) ?? false,
    ...(platformSandbox.agencLinuxSandboxExe !== undefined
      ? { agencLinuxSandboxExe: platformSandbox.agencLinuxSandboxExe }
      : {}),
    ...(networkInterfaces.policyDecider !== undefined
      ? { networkPolicyDecider: networkInterfaces.policyDecider }
      : {}),
    ...(networkInterfaces.blockedRequestObserver !== undefined
      ? { blockedRequestObserver: networkInterfaces.blockedRequestObserver }
      : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function networkPolicy(value: unknown): NetworkSandboxPolicy | undefined {
  return value === "enabled" || value === "disabled" || value === "restricted"
    ? value
    : undefined;
}

function networkPolicyInterfaces(value: unknown): {
  readonly policyDecider?: NetworkPolicyDecider;
  readonly blockedRequestObserver?: BlockedRequestObserver;
} {
  if (typeof value !== "object" || value === null) return {};
  const candidate = value as {
    readonly policyDecider?: unknown;
    readonly blockedRequestObserver?: unknown;
  };
  return {
    ...(isNetworkPolicyDecider(candidate.policyDecider)
      ? { policyDecider: candidate.policyDecider }
      : {}),
    ...(isBlockedRequestObserver(candidate.blockedRequestObserver)
      ? { blockedRequestObserver: candidate.blockedRequestObserver }
      : {}),
  };
}

function isNetworkPolicyDecider(value: unknown): value is NetworkPolicyDecider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly decide?: unknown }).decide === "function"
  );
}

function isBlockedRequestObserver(
  value: unknown,
): value is BlockedRequestObserver {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly onBlockedRequest?: unknown }).onBlockedRequest ===
      "function"
  );
}

function windowsSandboxLevel(value: unknown): WindowsSandboxLevel {
  switch (value) {
    case "low":
    case "medium":
    case "high":
      return value;
    case "permissive":
      return "low";
    case "strict":
      return "high";
    case "none":
    case "disabled":
    default:
      return "disabled";
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
    ...(error instanceof UnifiedExecError || error instanceof SandboxExecutionError
      ? {
          effectDisposition: confirmedNoEffectDisposition(
            "tool:system.exec-command:pre-spawn-error",
            message,
          ),
        }
      : {}),
  };
}

export function confirmedNoEffectDisposition(
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

/** A detached service that was still running when its yield window closed. */
function isDetachedAndRunning(output: ExecCommandToolOutput): boolean {
  return output.detached === true && output.exitCode === null;
}

/**
 * Whether the command's process is alive after the tool returned: yielded to
 * the caller with a session_id, or started detached and still running.
 */
function processStillAlive(output: ExecCommandToolOutput): boolean {
  return (
    isDetachedAndRunning(output) ||
    (output.exitCode === null && output.process_id !== undefined)
  );
}

function processObservationDisposition(
  cmd: string,
  cwd: string,
  output: ExecCommandToolOutput,
) {
  const evidenceRef = isDetachedAndRunning(output)
    ? "tool:system.exec-command:process-detached"
    : processStillAlive(output)
      ? "tool:system.exec-command:process-yield"
      : "tool:system.exec-command:process-exit";
  return createToolEffectDispositionEvidence({
    disposition: "confirmed_committed",
    evidenceKind: "provider_receipt",
    evidenceRef,
    evidenceMaterial: JSON.stringify({
      cmd,
      cwd,
      exitCode: output.exitCode,
      processId: output.process_id ?? null,
      ...(output.detached === true
        ? { detached: true, pid: output.pid ?? null }
        : {}),
      timedOut: output.timedOut,
      durationMs: output.durationMs,
    }),
  });
}

/**
 * Why `detach: true` cannot run here, or null when it can. A detached process
 * escapes every containment the sandbox lease relies on, so it exists only
 * where no sandbox applies; the message names the flag that gets there and
 * the sandboxed alternative.
 */
function detachRefusal(
  runtimeSandbox: UnifiedExecRuntimeSandbox | undefined,
  manager: UnifiedExecProcessManagerLike,
): ToolResult | null {
  const message =
    runtimeSandbox !== undefined
      ? "detach: true needs the danger-full-access sandbox: start AgenC with --dangerously-bypass-approvals-and-sandbox (or sandbox_mode = \"danger-full-access\"). In a sandboxed session keep the process alive with yield_time_ms instead; it stops when the session ends."
      : manager.startDetachedProcess === undefined
        ? "detach: true is not supported by this exec manager."
        : null;
  if (message === null) return null;
  return {
    content: safeStringify({ error: message }),
    isError: true,
    metadata: buildRecoverableToolFailureMetadata("exec_detach_unavailable"),
    effectDisposition: confirmedNoEffectDisposition(
      "tool:system.exec-command:detach-unavailable",
      message,
    ),
  };
}

const REMOVED_ALIAS_HINTS = {
  command: "the command line goes in `cmd`",
  cwd: "the working directory goes in `workdir`",
} as const;

function validateExecCommandInput(
  args: Readonly<Record<string, unknown>>,
  config: ExecCommandToolConfig | undefined,
): ToolPreflightFailure | null {
  for (const removedAlias of ["command", "cwd"] as const) {
    if (Object.prototype.hasOwnProperty.call(args, removedAlias)) {
      return { code: "invalid-input", message: `unknown field \`${removedAlias}\`; ${REMOVED_ALIAS_HINTS[removedAlias]}` };
    }
  }
  const permissions = parseSandboxPermissionsArgs(args);
  if (permissions.kind === "invalid") return { code: "invalid-input", message: permissions.reason };
  const cmd = asString(args.cmd);
  if (cmd === undefined) return { code: "invalid-input", message: "cmd must be a non-empty string" };
  if (args.detach !== undefined && typeof args.detach !== "boolean") {
    return { code: "invalid-input", message: "detach must be a boolean" };
  }
  if (args.detach === true && args.tty === true) {
    return { code: "invalid-input", message: "detach cannot be combined with tty; a detached service has no terminal" };
  }
  const workdir = asString(args.workdir);
  // The working directory may be the workspace, a directory the user added
  // with --add-dir, or anywhere when approvals are bypassed and no sandbox
  // applies (the command could `cd` there anyway; refusing only cost the
  // model a turn: `workdir: /tmp` was refused in every Terminal-Bench run).
  const context = readToolRuntimeContext(args as Record<string, unknown>);
  if (
    workdir !== undefined &&
    workdir.trim().length > 0 &&
    !shellBypassesApprovalsAndSandbox(context)
  ) {
    const canonicalPath = (candidate: string): string => {
      try {
        return existsSync(candidate) ? realpathSync(candidate) : candidate;
      } catch {
        return candidate;
      }
    };
    const resolvedWorkdir = canonicalPath(resolve(config?.cwd ?? process.cwd(), workdir));
    const roots = [
      ...(config?.allowedPaths ?? (config?.cwd !== undefined ? [config.cwd] : [])),
      ...shellAdditionalWriteRoots(context),
    ].map(canonicalPath);
    if (roots.length > 0 && !roots.some((root) =>
      resolvedWorkdir === root ||
      resolvedWorkdir.startsWith(root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`) ||
      resolvedWorkdir.startsWith(root.endsWith("/") || root.endsWith("\\") ? root : `${root}\\`),
    )) {
      return { code: "workdir-validation", message: `workdir is outside allowed workspace paths: ${workdir}` };
    }
  }
  if (isMcpShellPlaceholderCommand(cmd)) {
    return {
      code: "mcp-routing",
      message: "MCP tools are not shell commands. Load the tool with system.searchTools if needed, then call the mcp.<server>.<tool> tool directly with JSON arguments. Do not simulate MCP results with exec_command.",
    };
  }
  return null;
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
      "Run a shell command in the current AgenC workspace and return captured stdout/stderr. Use this for inspection, tests, builds, and other terminal work. Use Edit or Write for source-file edits; delete or rename workspace files here with rm or mv. Never use this to print commentary, placeholders, or reminders to yourself; call the relevant tool directly instead.\n\nLong-running commands: set a short yield_time_ms to run in the BACKGROUND — when the command outlives the yield window the result carries a session_id and the process keeps running. Poll for more output with write_stdin(session_id, chars='') and stop it with kill_process(session_id). Prefer this over trailing '&' (a shell-backgrounded child has no session_id, so its output is unrecoverable).\n\nServices: every process a command leaves behind (a trailing '&', nohup, setsid, a daemon that forks) is stopped when the command returns, and a process kept alive with yield_time_ms is stopped when the session ends. To start a web server, database, sshd, or other daemon that must keep running afterwards, set detach: true (needs the danger-full-access sandbox); the result carries its pid and log file.",
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
    // Unified exec owns explicit command timeouts and foreground yields.
    // The generic executor must not invent a second deadline.
    timeoutBehavior: "tool",
    recoveryCategory: "side-effecting",
    // Transcript collapsing keys off this. BashTool has declared it since
    // forever; exec_command never did, so every `ls`, `cat`, `which` and `id`
    // the agent ran was rendered in full instead of folding into a one-line
    // "Read N files" summary. On a hardware-debugging session that is most of
    // the transcript — and most of the context budget. Same classifier as
    // Bash, so a build or an upload still renders in full: those are the ones
    // worth looking at.
    isSearchOrReadCommand: (input: { cmd?: string }) =>
      isSearchOrReadBashCommand(input?.cmd ?? ""),
    supportsParallelToolCalls: false,
    isConcurrencySafe: () => false,
    interruptBehavior: () => "cancel",
    preflight(args) {
      const failure = validateExecCommandInput(args, config);
      if (failure !== null) return failure;
      const cmd = asString(args.cmd)!;
      if (args.tty === true && isPlainInteractiveShellCommand(cmd)) return null;
      const workdir = asString(args.workdir);
      return preflightShellWorkspaceWritePolicy({
        toolName: "exec_command",
        args: { command: cmd, ...(workdir !== undefined ? { cwd: workdir } : {}) },
        workspaceRoot: config?.cwd ?? config?.allowedPaths?.[0],
        ...shellWorkspaceMutationPermission(args),
      });
    },
    inputSchema: {
      type: "object",
      properties: {
        cmd: {
          type: "string",
          description:
            "Shell command to execute. MCP tool names such as mcp.server.tool are not shell commands; call those tools directly. Do not use echo/printf placeholders like \"I need to call the MCP tool\".",
        },
        workdir: {
          type: "string",
          description: "Working directory. Defaults to the AgenC workspace root.",
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
        detach: {
          type: "boolean",
          description:
            "Start the command as a detached service: its own session, stdout/stderr to a log file, never stopped by AgenC, so it survives this command returning and the session ending. Waits yield_time_ms (default 2000) for an early exit, then returns pid and log path. Only under the danger-full-access sandbox (--dangerously-bypass-approvals-and-sandbox); not with tty.",
        },
        ...SANDBOX_PERMISSION_INPUT_PROPERTIES,
        prefix_rule: {
          type: "array",
          items: { type: "string" },
          description: "Approval-cache command prefix rule, when applicable.",
        },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as Record<string, unknown> & ToolExecutionInjectedArgs;
      const failure = validateExecCommandInput(args, config);
      if (failure !== null) {
        return {
          content: safeStringify({ error: failure.message }),
          isError: true,
          ...(failure.code === "mcp-routing" ? { metadata: buildRecoverableToolFailureMetadata("mcp_tool_not_shell_command") } : {}),
          effectDisposition: confirmedNoEffectDisposition(
            `tool:system.exec-command:${failure.code}`,
            failure.message,
          ),
        };
      }
      const cmd = asString(args.cmd)!;
      const workdir = asString(args.workdir);
      const timeoutMs = asNumber(args.timeoutMs);
      const tty = asBoolean(args.tty);
      const detach = asBoolean(args.detach) === true;

      if (!(tty === true && isPlainInteractiveShellCommand(cmd))) {
        const workspaceWriteDecision = classifyShellWorkspaceWritePolicy({
          toolName: "exec_command",
          args: {
            command: cmd,
            ...(workdir !== undefined ? { cwd: workdir } : {}),
          },
          workspaceRoot: config?.cwd ?? config?.allowedPaths?.[0],
          ...shellWorkspaceMutationPermission(args),
        });
        if (workspaceWriteDecision.blocked) {
          const message =
            workspaceWriteDecision.message ??
            "Shell workspace write policy blocked the command.";
          return {
            content: safeStringify({ error: message }),
            isError: true,
            metadata: buildRecoverableToolFailureMetadata(
              "shell_workspace_write_policy",
            ),
            effectDisposition: confirmedNoEffectDisposition(
              "tool:system.exec-command:workspace-write-policy",
              message,
            ),
          };
        }
      }

      try {
        const inspection = readReadOnlyInspectionInvocation(args);
        const runtimeSandbox = inspection?.runtimeSandbox ?? runtimeSandboxForExec(
          args,
          config?.cwd ?? process.cwd(),
        );
        if (detach) {
          const refusal = detachRefusal(runtimeSandbox, manager);
          if (refusal !== null) return refusal;
        }
        const ownerId = processOwnerIdFromToolArgs(
          args as Record<string, unknown>,
        );
        const shellRequest = {
          ...(workdir !== undefined ? { workdir } : {}),
          ...(asString(args.shell) !== undefined ? { shell: asString(args.shell) } : {}),
          ...(asBoolean(args.login) !== undefined ? { login: asBoolean(args.login) } : {}),
        };
        const commonRequest = {
          cmd,
          callId: asString(args.__callId),
          ...(asNumber(args.yield_time_ms) !== undefined
            ? { yield_time_ms: asNumber(args.yield_time_ms) }
            : {}),
          ...(asNumber(args.max_output_tokens) !== undefined
            ? { max_output_tokens: asNumber(args.max_output_tokens) }
            : {}),
          ...(args.__abortSignal !== undefined
            ? { __abortSignal: args.__abortSignal }
            : {}),
          ...(config?.execObserver !== undefined
            ? { observer: config.execObserver }
            : {}),
        };
        const output = detach
          ? await manager.startDetachedProcess!({ ...commonRequest, ...shellRequest })
          : await manager.execCommand({
              ...commonRequest,
              ...(inspection !== undefined
                ? { directInvocation: inspection, workdir: inspection.cwd }
                : { ...shellRequest, ...(tty !== undefined ? { tty } : {}) }),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              ...(args.__onProgress !== undefined
                ? { __onProgress: args.__onProgress }
                : {}),
              ...(runtimeSandbox !== undefined ? { runtimeSandbox } : {}),
              ...(ownerId !== undefined ? { ownerId } : {}),
            });
        // exitCode === null has these sub-cases. The reliable discriminator
        // is `process_id !== undefined` (or `detached` with a pid):
        //   - process_id set    → process is still alive (YIELDED to
        //                         caller; can resume via write_stdin).
        //                         `timedOut` is NOT a kill marker here —
        //                         it just means the yield window
        //                         elapsed. Not an error.
        //   - detached + pid    → a detached service still running when
        //                         its yield window closed. Not an error.
        //   - process_id absent + timedOut    → configured timeout
        //                                       fired AND process was
        //                                       killed. Error.
        //   - process_id absent + !timedOut   → terminated by external
        //                                       signal (SIGKILL/OOM/
        //                                       sandbox kill). Error.
        // Previously isError was `exitCode !== null && exitCode !== 0`,
        // which evaluated to false for ALL null-exitCode cases and
        // produced a silent success on signal kill.
        const stillAlive = processStillAlive(output);
        const isError =
          (output.exitCode !== null && output.exitCode !== 0) ||
          (output.exitCode === null && !stillAlive);
        // An OS-level sandbox refusal reaches us only as the child's own
        // errno text. Say plainly that the sandbox did it and whether
        // escalation can change the answer, so a denial reads as a verdict
        // instead of an invitation to retry with a longer timeout.
        const execContent = formatUnifiedExecToolContent(output);
        const runtimeContext = readToolRuntimeContext(args);
        const denial = execSandboxDenialNotice({
          output: execContent,
          exitCode: output.exitCode,
          sandboxApplied: runtimeSandbox !== undefined,
          escalationAvailable:
            runtimeContext === undefined ||
            sandboxEscalationAvailable(runtimeContext.approvalPolicy),
        });
        return {
          content:
            denial === null ? execContent : `${execContent}\n\n${denial.notice}`,
          isError: isError || undefined,
          codeModeResult: unifiedExecCodeModeResult(output),
          effectDisposition: processObservationDisposition(
            cmd,
            workdir ?? config?.cwd ?? process.cwd(),
            output,
          ),
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
            ...(output.detached === true
              ? {
                  detached: true,
                  ...(output.pid !== undefined ? { pid: output.pid } : {}),
                  ...(output.log_path !== undefined ? { logPath: output.log_path } : {}),
                }
              : {}),
            ...(output.residual_processes_terminated === true
              ? { residualProcessesTerminated: true }
              : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
