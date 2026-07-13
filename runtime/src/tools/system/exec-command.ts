import { resolve } from "node:path";

import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import type { BashToolConfig } from "./types.js";
import { UnifiedExecError } from "../../unified-exec/types.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type { UnifiedExecProcessManagerLike, UnifiedExecRuntimeSandbox } from "../../unified-exec/types.js";
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
  formatUnifiedExecToolContent,
  unifiedExecCodeModeResult,
} from "./exec-result-format.js";
import { buildRecoverableToolFailureMetadata } from "../result-metadata.js";
import { nonEmptyString as asString } from "../../utils/stringUtils.js";
import { readToolRuntimeContext } from "../runtimes/context.js";
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

export function runtimeSandboxForExec(
  args: Record<string, unknown>,
  fallbackCwd: string,
): UnifiedExecRuntimeSandbox | undefined {
  const context = readToolRuntimeContext(args);
  if (
    context === undefined ||
    !sandboxModeRequiresPlatformIsolation(context.sandboxMode)
  ) {
    return undefined;
  }
  const platformSandbox = runtimePlatformSandboxStatus(context);
  if (!platformSandbox.available) return undefined;
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
    preference: "require",
    ...(booleanValue(turn.config?.sandboxAllowGpu) === true
      ? { allowGpu: true }
      : {}),
    useLegacyLandlock: useLegacyLandlock(turn.features ?? turn.config?.features),
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

function useLegacyLandlock(features: unknown): boolean {
  if (typeof features !== "object" || features === null) return false;
  const candidate = features as {
    readonly useLegacyLandlock?: unknown;
    readonly enabled?: unknown;
  };
  if (typeof candidate.useLegacyLandlock === "function") {
    return candidate.useLegacyLandlock() === true;
  }
  if (typeof candidate.enabled === "function") {
    return candidate.enabled("use_legacy_landlock") === true;
  }
  return false;
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
      "Run a shell command in the current AgenC workspace and return captured stdout/stderr. Use this for inspection, tests, builds, and other terminal work. Use Edit or Write for source-file edits. Never use this to print commentary, placeholders, or reminders to yourself; call the relevant tool directly instead.\n\nLong-running commands: set a short yield_time_ms to run in the BACKGROUND — when the command outlives the yield window the result carries a session_id and the process keeps running. Poll for more output with write_stdin(session_id, chars='') and stop it with kill_process(session_id). Prefer this over trailing '&' (a shell-backgrounded child has no session_id, so its output is unrecoverable).",
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
    recoveryCategory: "side-effecting",
    supportsParallelToolCalls: false,
    isConcurrencySafe: () => false,
    interruptBehavior: () => "cancel",
    inputSchema: {
      type: "object",
      properties: {
        cmd: {
          type: "string",
          description:
            "Shell command to execute. MCP tool names such as mcp.server.tool are not shell commands; call those tools directly. Do not use echo/printf placeholders like \"I need to call the MCP tool\".",
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
          anyOf: [
            {
              type: "string",
              enum: [
                "default",
                "require_escalated",
                "with_additional_permissions",
              ],
            },
            { type: "object" },
          ],
          description:
            "Sandbox escalation mode or scoped permission request.",
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

      // Constrain workdir to allowedPaths / workspace root (todo-132).
      if (workdir !== undefined && workdir.trim().length > 0) {
        const { resolve: pathResolve, isAbsolute } = await import("node:path");
        const { realpathSync, existsSync } = await import("node:fs");
        let resolvedWorkdir = isAbsolute(workdir)
          ? workdir
          : pathResolve(config?.cwd ?? process.cwd(), workdir);
        try {
          if (existsSync(resolvedWorkdir)) {
            resolvedWorkdir = realpathSync(resolvedWorkdir);
          }
        } catch {
          /* keep resolvedWorkdir */
        }
        const roots = (
          config?.allowedPaths ??
          (config?.cwd !== undefined ? [config.cwd] : [])
        ).map((r) => {
          try {
            return existsSync(r) ? realpathSync(r) : r;
          } catch {
            return r;
          }
        });
        if (roots.length > 0) {
          const allowed = roots.some(
            (root) =>
              resolvedWorkdir === root ||
              resolvedWorkdir.startsWith(
                root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`,
              ) ||
              resolvedWorkdir.startsWith(
                root.endsWith("/") || root.endsWith("\\") ? root : `${root}\\`,
              ),
          );
          if (!allowed) {
            return {
              content: safeStringify({
                error: `workdir is outside allowed workspace paths: ${workdir}`,
              }),
              isError: true,
            };
          }
        }
      }

      if (isMcpShellPlaceholderCommand(cmd)) {
        return {
          content: safeStringify({
            error:
              "MCP tools are not shell commands. Load the tool with system.searchTools if needed, then call the mcp.<server>.<tool> tool directly with JSON arguments. Do not simulate MCP results with exec_command.",
          }),
          isError: true,
          metadata: buildRecoverableToolFailureMetadata(
            "mcp_tool_not_shell_command",
          ),
        };
      }

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
            metadata: buildRecoverableToolFailureMetadata(
              "shell_workspace_write_policy",
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
          ...(runtimeSandbox !== undefined ? { runtimeSandbox } : {}),
          ...(ownerId !== undefined ? { ownerId } : {}),
        });
        // exitCode === null has three meaningful sub-cases. The
        // reliable discriminator is `process_id !== undefined`:
        //   - process_id set    → process is still alive (YIELDED to
        //                         caller; can resume via write_stdin).
        //                         `timedOut` is NOT a kill marker here —
        //                         it just means the yield window
        //                         elapsed. Not an error.
        //   - process_id absent + timedOut    → configured timeout
        //                                       fired AND process was
        //                                       killed. Error.
        //   - process_id absent + !timedOut   → terminated by external
        //                                       signal (SIGKILL/OOM/
        //                                       sandbox kill). Error.
        // Previously isError was `exitCode !== null && exitCode !== 0`,
        // which evaluated to false for ALL null-exitCode cases and
        // produced a silent success on signal kill.
        const stillAlive =
          output.exitCode === null && output.process_id !== undefined;
        const isError =
          (output.exitCode !== null && output.exitCode !== 0) ||
          (output.exitCode === null && !stillAlive);
        return {
          content: formatUnifiedExecToolContent(output),
          isError: isError || undefined,
          codeModeResult: unifiedExecCodeModeResult(output),
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
