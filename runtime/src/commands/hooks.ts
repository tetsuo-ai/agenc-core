import { HOOK_EVENT_NAMES, normalizeHookEventName } from "../config/schema.js";
import type { HookEventName } from "../config/schema.js";
import type {
  ConfiguredHooksRuntime,
  HookRunDiagnostic,
  IndividualHookConfig,
} from "../hooks/configured-hooks.js";
import {
  groupHooksByEvent,
  hookDisplayText,
} from "../hooks/configured-hooks.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

function findHooksRuntime(ctx: SlashCommandContext): ConfiguredHooksRuntime | null {
  return ctx.session.services.hooksRuntime ?? null;
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
    case "SessionStart":
      return {
        summary: "When a new session is started",
        matcher: "source",
        description:
          "Input is JSON with session start source. Exit code 0 can add context for AgenC. Blocking errors are ignored.",
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

function formatOverview(runtime: ConfiguredHooksRuntime): string {
  const hooks = runtime.listHooks();
  const grouped = groupHooksByEvent(hooks);
  const issues = runtime.issues();
  const lines = [
    "AgenC Hooks",
    `Source: ${runtime.sourcePath()}`,
    `State: ${runtime.isDisabled() ? "disabled for this session" : "enabled"}`,
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

function formatDiagnostics(runtime: ConfiguredHooksRuntime): string {
  return formatDiagnosticList(runtime.latestDiagnostics());
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
  runtime: ConfiguredHooksRuntime,
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
  const eventHooks = runtime.listHooks().filter((h) => h.event === event);
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

async function handleHooksCommand(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const runtime = findHooksRuntime(ctx);
  if (!runtime) {
    return {
      kind: "error",
      message: "Hooks runtime is not available in this session.",
    };
  }
  const args = ctx.argsRaw.split(/\s+/).filter(Boolean);
  const subcommand = (args[0] ?? "list").toLowerCase();
  switch (subcommand) {
    case "list":
    case "show-all":
    case "overview":
      return { kind: "text", text: formatOverview(runtime) };
    case "validate": {
      const issues = runtime.issues();
      return {
        kind: "text",
        text:
          issues.length === 0
            ? `AgenC Hooks\nSource: ${runtime.sourcePath()}\nValidation: ok`
            : `AgenC Hooks\nSource: ${runtime.sourcePath()}\nValidation issues:\n${issues
                .map((issue) => `${issue.level.toUpperCase()}: ${issue.message}`)
                .join("\n")}`,
      };
    }
    case "enable":
      runtime.setDisabled(false);
      return { kind: "text", text: "AgenC hooks enabled for this session." };
    case "disable":
      runtime.setDisabled(true);
      return { kind: "text", text: "AgenC hooks disabled for this session." };
    case "diagnostics":
    case "diag":
      return { kind: "text", text: formatDiagnostics(runtime) };
    case "clear-diagnostics":
    case "clear":
      runtime.clearDiagnostics();
      return { kind: "text", text: "AgenC hook diagnostics cleared." };
    case "show": {
      const hook = resolveHook(runtime, args.slice(1));
      if ("kind" in hook) return hook;
      return { kind: "text", text: formatDetails(hook) };
    }
    case "test":
    case "run": {
      const hook = resolveHook(runtime, args.slice(1));
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
  immediate: true,
  execute: (ctx) => safeExecute(() => handleHooksCommand(ctx)),
};

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

export default hooksCommand;
