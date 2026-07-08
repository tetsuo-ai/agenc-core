import { HOOK_EVENT_NAMES, normalizeHookEventName } from "../config/schema.js";
import type { HookEventName } from "../config/schema.js";
import type {
  ConfiguredHooksRuntime,
  HookRunDiagnostic,
  HookValidationIssue,
  IndividualHookConfig,
} from "../hooks/configured-hooks.js";
import {
  groupHooksByEvent,
  hookDisplayText,
} from "../hooks/configured-hooks.js";
import type {
  SessionHooksSetDisabledResult,
  SessionHooksStatusResult,
} from "../app-server/protocol/index.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import { HooksRuntimeUnavailableModal, openHooksMenu } from "./hooks-menu.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import React from "react";

function findHooksRuntime(ctx: SlashCommandContext): ConfiguredHooksRuntime | null {
  return ctx.session.services?.hooksRuntime ?? null;
}

/**
 * Plain, serializable view of a hooks runtime's state. Shared by both the
 * in-process path (built from a live `ConfiguredHooksRuntime`) and the
 * daemon path (built from the `session.hooks.status` RPC snapshot), so the
 * rendering helpers stay path-agnostic.
 */
interface HooksSnapshot {
  readonly sourcePath: string;
  readonly disabled: boolean;
  readonly issues: readonly HookValidationIssue[];
  readonly hooks: readonly IndividualHookConfig[];
  readonly diagnostics: readonly HookRunDiagnostic[];
}

function snapshotFromRuntime(runtime: ConfiguredHooksRuntime): HooksSnapshot {
  return {
    sourcePath: runtime.sourcePath(),
    disabled: runtime.isDisabled(),
    issues: runtime.issues(),
    hooks: runtime.listHooks(),
    diagnostics: runtime.latestDiagnostics(),
  };
}

/**
 * Adapt the daemon RPC snapshot (whose field types are protocol mirror
 * interfaces) to the local `HooksSnapshot`. The shapes are structurally
 * identical; the cast narrows the wire `string` unions back to the local
 * branded enums for rendering.
 */
function snapshotFromDaemonStatus(
  status: SessionHooksStatusResult,
): HooksSnapshot {
  return {
    sourcePath: status.sourcePath,
    disabled: status.disabled,
    issues: status.issues as readonly HookValidationIssue[],
    hooks: status.hooks as unknown as readonly IndividualHookConfig[],
    diagnostics: status.diagnostics as unknown as readonly HookRunDiagnostic[],
  };
}

interface DaemonHooksFns {
  readonly status: () => Promise<SessionHooksStatusResult>;
  readonly setDisabled?: (
    disabled: boolean,
  ) => Promise<SessionHooksSetDisabledResult>;
}

function daemonHooksFns(ctx: SlashCommandContext): DaemonHooksFns | null {
  const s = ctx.session as unknown as {
    getDaemonHooksStatus?: () => Promise<SessionHooksStatusResult>;
    setDaemonHooksDisabled?: (
      disabled: boolean,
    ) => Promise<SessionHooksSetDisabledResult>;
  };
  if (typeof s.getDaemonHooksStatus !== "function") return null;
  return {
    status: s.getDaemonHooksStatus.bind(s),
    ...(typeof s.setDaemonHooksDisabled === "function"
      ? { setDisabled: s.setDaemonHooksDisabled.bind(s) }
      : {}),
  };
}

function openHooksUnavailableMenu(ctx: SlashCommandContext): boolean {
  return openLocalJsxCommand(ctx, close =>
    React.createElement(HooksRuntimeUnavailableModal, { onDone: close }),
  );
}

function metadataFor(event: HookEventName): {
  readonly summary: string;
  readonly matcher?: string;
  readonly description: string;
} {
  switch (event) {
    case "PreToolUse":
      return {
        summary: "Before tool execution",
        matcher: "tool_name",
        description:
          "Input is JSON of tool call arguments. Exit code 0 continues. Exit code 2 shows stderr to the model and blocks the tool call. Other exit codes show stderr to the user only and continue.",
      };
    case "PostToolUse":
      return {
        summary: "After tool execution",
        matcher: "tool_name",
        description:
          "Input is JSON with inputs and response fields. Exit code 0 can add context. Exit code 2 shows stderr to the model immediately. Other exit codes show stderr to the user only.",
      };
    case "PostToolUseFailure":
      return {
        summary: "After tool execution fails",
        matcher: "tool_name",
        description:
          "Input is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout. Hook output is diagnostic unless it is surfaced by the caller.",
      };
    case "PermissionRequest":
      return {
        summary: "When a permission dialog is displayed",
        matcher: "tool_name",
        description:
          "Input is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing a decision to allow or deny.",
      };
    case "UserPromptSubmit":
      return {
        summary: "When a user prompt is submitted",
        description:
          "Input is JSON with prompt, cwd, and permission_mode. Exit code 0 can add context. Exit code 2 blocks the prompt before it reaches the model. Other exit codes are diagnostic only.",
      };
    case "SessionStart":
      return {
        summary: "When a new session is started",
        matcher: "source",
        description:
          "Input is JSON with session start source. Exit code 0 can add context for AgenC. Blocking errors are ignored.",
      };
    case "SubagentStop":
      return {
        summary: "When a spawned subagent reaches a terminal state",
        matcher: "agent_type",
        description:
          "Input is JSON with task_name, agent_id, agent_type, outcome, and final_message. Exit code 2 (or hookSpecificOutput additionalContext) appends feedback to the completion notification the parent agent reads.",
      };
    case "SessionEnd":
      return {
        summary: "When the session shuts down",
        matcher: "reason",
        description:
          "Input is JSON with the shutdown reason. Fire-and-forget: output and exit codes are recorded as diagnostics only.",
      };
    case "Notification":
      return {
        summary: "When AgenC is waiting on the user",
        matcher: "notification_type",
        description:
          "Input is JSON with message and notification_type (e.g. permission_request). Use for desktop/OS alerting. Fire-and-forget.",
      };
    case "Stop":
      return {
        summary: "Right before AgenC concludes its response",
        description:
          "Exit code 0 completes. Exit code 2 shows stderr to the model and continues the conversation. Other exit codes show stderr to the user only.",
      };
    case "StopFailure":
      return {
        summary: "When the turn ends due to an API error",
        matcher: "error",
        description:
          "Fires instead of Stop when an API error ended the turn. Fire-and-forget: hook output and exit codes are recorded as diagnostics.",
      };
    case "PreCompact":
      return {
        summary: "Before conversation compaction",
        matcher: "trigger",
        description:
          "Input is JSON with compaction details. Exit code 0 appends stdout as custom compact instructions. Exit code 2 records a blocking failure.",
      };
    case "PostCompact":
      return {
        summary: "After conversation compaction",
        matcher: "trigger",
        description:
          "Input is JSON with compaction details and the summary. Exit code 0 shows stdout to the user. Other exit codes are recorded as diagnostics.",
      };
  }
}

function formatOverview(snapshot: HooksSnapshot): string {
  const hooks = snapshot.hooks;
  const grouped = groupHooksByEvent(hooks);
  const issues = snapshot.issues;
  const lines = [
    "AgenC Hooks",
    `Source: ${snapshot.sourcePath}`,
    `State: ${snapshot.disabled ? "disabled for this session" : "enabled"}`,
    `Validation: ${issues.length === 0 ? "ok" : `${issues.length} issue(s)`}`,
    `Configured hooks: ${hooks.length}`,
    "",
  ];
  if (issues.length > 0) {
    for (const issue of issues) lines.push(`${issue.level.toUpperCase()}: ${issue.message}`);
    lines.push("");
  }
  for (const event of HOOK_EVENT_NAMES) {
    const eventHooks = grouped.get(event) ?? [];
    const meta = metadataFor(event);
    lines.push(`${event}: ${eventHooks.length} ${eventHooks.length === 1 ? "hook" : "hooks"} - ${meta.summary}`);
    for (const hook of eventHooks) {
      const matcher = hook.matcher ? `[${hook.matcher}] ` : "";
      const enabled = hook.enabled ? "enabled" : "disabled";
      lines.push(`  #${hook.index} ${matcher}${hookDisplayText(hook)} (${enabled})`);
    }
  }
  lines.push("");
  lines.push("Commands: /hooks show <event> [index], /hooks test <event> [index], /hooks diagnostics, /hooks enable, /hooks disable");
  return lines.join("\n");
}

function formatDetails(hook: IndividualHookConfig): string {
  const meta = metadataFor(hook.event);
  return [
    "AgenC Hook",
    `Event: ${hook.event}`,
    `Summary: ${meta.summary}`,
    ...(meta.matcher !== undefined ? [`Matcher field: ${meta.matcher}`] : []),
    `Matcher: ${hook.matcher ?? "(all)"}`,
    `Source: ${hook.sourcePath}`,
    `Status: ${hook.enabled ? "enabled" : "disabled"}`,
    `Type: ${hook.command.type}`,
    `Timeout: ${hook.command.timeout_ms ?? 60_000}ms`,
    `Command: ${hook.command.command}`,
    "",
    meta.description,
  ].join("\n");
}

function formatDiagnosticList(diagnostics: readonly HookRunDiagnostic[]): string {
  const lines = ["AgenC Hook Diagnostics"];
  if (diagnostics.length === 0) {
    lines.push("No hook runs recorded.");
    return lines.join("\n");
  }
  for (const diag of diagnostics.slice(0, 10)) {
    const matcher = diag.matcher ? ` [${diag.matcher}]` : "";
    const code = diag.exitCode !== undefined ? ` exit=${diag.exitCode}` : "";
    lines.push(
      `${diag.event}${matcher}: ${diag.status}${code} ${diag.durationMs}ms - ${diag.command}`,
    );
    if (diag.error) lines.push(`  error: ${diag.error}`);
    if (diag.stderr.trim()) lines.push(`  stderr: ${firstLine(diag.stderr)}`);
    if (diag.stdout.trim()) lines.push(`  stdout: ${firstLine(diag.stdout)}`);
  }
  return lines.join("\n");
}

function resolveHook(
  hooks: readonly IndividualHookConfig[],
  args: readonly string[],
): IndividualHookConfig | SlashCommandResult {
  const eventRaw = args[0] ?? "";
  const event = normalizeHookEventName(eventRaw);
  if (!event) {
    return {
      kind: "error",
      message: `Usage: /hooks show <event> [index]. Events: ${HOOK_EVENT_NAMES.join(", ")}`,
    };
  }
  const eventHooks = hooks.filter((h) => h.event === event);
  if (eventHooks.length === 0) {
    return { kind: "error", message: `No hooks configured for ${event}.` };
  }
  const selector = args[1];
  if (selector === undefined) return eventHooks[0]!;
  const numeric = Number.parseInt(selector, 10);
  if (Number.isInteger(numeric)) {
    const byIndex = eventHooks.find((h) => h.index === numeric || eventHooks.indexOf(h) === numeric);
    if (byIndex) return byIndex;
  }
  const byMatcher = eventHooks.find((h) => h.matcher === selector);
  if (byMatcher) return byMatcher;
  return {
    kind: "error",
    message: `No ${event} hook matched selector "${selector}".`,
  };
}

function renderValidate(snapshot: HooksSnapshot): string {
  const issues = snapshot.issues;
  return issues.length === 0
    ? `AgenC Hooks\nSource: ${snapshot.sourcePath}\nValidation: ok`
    : `AgenC Hooks\nSource: ${snapshot.sourcePath}\nValidation issues:\n${issues
        .map((issue) => `${issue.level.toUpperCase()}: ${issue.message}`)
        .join("\n")}`;
}

/**
 * Daemon-backed `/hooks`: the bridge session has no local `ConfiguredHooksRuntime`
 * (it lives on the daemon agent session), so read state via the
 * `session.hooks.status` RPC snapshot and route mutations through
 * `session.hooks.setDisabled`. `test`/`run` and `clear-diagnostics` are
 * deferred against the daemon (need a daemon-side trust-gate review for
 * executing/clearing on behalf of a client RPC).
 */
async function handleDaemonHooksCommand(
  daemon: DaemonHooksFns,
  args: readonly string[],
): Promise<SlashCommandResult> {
  const subcommand = (args[0] ?? "list").toLowerCase();
  if (subcommand === "test" || subcommand === "run") {
    return {
      kind: "text",
      text: "/hooks test is not yet available against the daemon (deferred).",
    };
  }
  if (subcommand === "clear-diagnostics" || subcommand === "clear") {
    return {
      kind: "text",
      text: "/hooks clear-diagnostics is not yet available against the daemon (deferred).",
    };
  }
  if (subcommand === "enable" || subcommand === "disable") {
    if (daemon.setDisabled === undefined) {
      return {
        kind: "error",
        message: "Hooks enable/disable is not available against the daemon.",
      };
    }
    const disabled = subcommand === "disable";
    await daemon.setDisabled(disabled);
    return {
      kind: "text",
      text: disabled
        ? "AgenC hooks disabled for this session."
        : "AgenC hooks enabled for this session.",
    };
  }
  const status = await daemon.status();
  if (!status.available) {
    return {
      kind: "error",
      message: "Hooks runtime is not available in this session.",
    };
  }
  const snapshot = snapshotFromDaemonStatus(status);
  switch (subcommand) {
    case "list":
    case "show-all":
    case "overview":
      // The interactive hooks menu requires a live ConfiguredHooksRuntime;
      // on the daemon path render the text overview instead (menu deferred).
      return { kind: "text", text: formatOverview(snapshot) };
    case "validate":
      return { kind: "text", text: renderValidate(snapshot) };
    case "diagnostics":
    case "diag":
      return { kind: "text", text: formatDiagnosticList(snapshot.diagnostics) };
    case "show": {
      const hook = resolveHook(snapshot.hooks, args.slice(1));
      if ("kind" in hook) return hook;
      return { kind: "text", text: formatDetails(hook) };
    }
    default:
      return {
        kind: "error",
        message:
          "Usage: /hooks [list|show|validate|enable|disable|test|diagnostics|clear-diagnostics]",
      };
  }
}

async function handleHooksCommand(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const runtime = findHooksRuntime(ctx);
  if (!runtime) {
    // Daemon-backed TUI: no local runtime on the bridge session — route to
    // the daemon's real hooks runtime via the bridge forwarder.
    const daemon = daemonHooksFns(ctx);
    if (daemon) {
      const args = ctx.argsRaw.split(/\s+/).filter(Boolean);
      return handleDaemonHooksCommand(daemon, args);
    }
    if (ctx.argsRaw.trim().length === 0 && openHooksUnavailableMenu(ctx)) {
      return { kind: "skip" };
    }
    return {
      kind: "error",
      message: "Hooks runtime is not available in this session.",
    };
  }
  const args = ctx.argsRaw.split(/\s+/).filter(Boolean);
  const subcommand = (args[0] ?? "list").toLowerCase();
  const snapshot = snapshotFromRuntime(runtime);
  switch (subcommand) {
    case "list":
    case "show-all":
    case "overview":
      if (args.length === 0 && openHooksMenu(ctx, runtime)) {
        return { kind: "skip" };
      }
      return { kind: "text", text: formatOverview(snapshot) };
    case "validate":
      return { kind: "text", text: renderValidate(snapshot) };
    case "enable":
      runtime.setDisabled(false);
      return { kind: "text", text: "AgenC hooks enabled for this session." };
    case "disable":
      runtime.setDisabled(true);
      return { kind: "text", text: "AgenC hooks disabled for this session." };
    case "diagnostics":
    case "diag":
      return { kind: "text", text: formatDiagnosticList(snapshot.diagnostics) };
    case "clear-diagnostics":
    case "clear":
      runtime.clearDiagnostics();
      return { kind: "text", text: "AgenC hook diagnostics cleared." };
    case "show": {
      const hook = resolveHook(snapshot.hooks, args.slice(1));
      if ("kind" in hook) return hook;
      return { kind: "text", text: formatDetails(hook) };
    }
    case "test":
    case "run": {
      const hook = resolveHook(snapshot.hooks, args.slice(1));
      if ("kind" in hook) return hook;
      const diag = await runtime.testHook(hook);
      return {
        kind: "text",
        text: formatDiagnosticList([diag]),
      };
    }
    default:
      return {
        kind: "error",
        message:
          "Usage: /hooks [list|show|validate|enable|disable|test|diagnostics|clear-diagnostics]",
      };
  }
}

const hooksCommand: SlashCommand = {
  name: "hooks",
  description: "Inspect and test AgenC hook configuration",
  supportedSurfaces: ["runtime", "daemon-tui"],
  immediate: true,
  execute: (ctx) => safeExecute(() => handleHooksCommand(ctx)),
};

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

export default hooksCommand;
