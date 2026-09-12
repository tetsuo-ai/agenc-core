import { matchedDangerousShellCommandLabel } from "./dangerous-patterns.js";

export type ApprovalRiskTier = "low" | "medium" | "destructive";

const DATA_BEARING_BUILTIN_TOOL_NAMES = new Set([
  "FileRead",
  "Glob",
  "Grep",
  "spawn_agent",
  "send_message",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "Write",
  "Edit",
  "NotebookEdit",
  "CronCreate",
]);

const SHELL_COMMAND_FRAGMENT = String.raw`[^;&|\n]*`;
const RECURSIVE_FORCE_RM_BUNDLED_FLAGS = new RegExp(
  [
    String.raw`\brm\b${SHELL_COMMAND_FRAGMENT}\s+-[a-z]*r[a-z]*f[a-z]*\b`,
    String.raw`\brm\b${SHELL_COMMAND_FRAGMENT}\s+-[a-z]*f[a-z]*r[a-z]*\b`,
  ].join("|"),
  "iu",
);
const RECURSIVE_FORCE_RM_SPLIT_FLAGS = new RegExp(
  String.raw`\brm\b(?=${SHELL_COMMAND_FRAGMENT}\s+(?:-[a-z]*r[a-z]*\b|--recursive\b))(?=${SHELL_COMMAND_FRAGMENT}\s+(?:-[a-z]*f[a-z]*\b|--force\b))`,
  "iu",
);

export function classifyApprovalRisk(input: {
  readonly request?: { readonly ctx?: { readonly toolName?: unknown } };
  readonly toolName?: string;
  readonly description?: string;
  readonly command?: string;
  readonly toolInput?: unknown;
}): ApprovalRiskTier {
  const requestToolName =
    typeof input.request?.ctx?.toolName === "string"
      ? input.request.ctx.toolName
      : undefined;
  if (requestToolName === "CronDelete" || input.toolName === "CronDelete") {
    return "destructive";
  }
  const command = input.toolInput === undefined
    ? input.command
    : approvalActionText(input.toolInput, input.toolName ?? requestToolName);
  const haystack = [
    requestToolName?.replaceAll("_", " "),
    input.toolName?.replaceAll("_", " "),
    input.description,
    command,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (commandLooksDestructive(command)) {
    return "destructive";
  }
  // "slash" is deliberately NOT a destructive keyword: it collides with the
  // everyday "slash command" (the `/` command surface), so a TodoWrite about
  // the slash-command registry was misclassified as a destructive Solana
  // slash and forced a typed confirmation. Real slashing still escalates via
  // settle/stake/escrow context and the command heuristics.
  if (/\b(delete|destroy|wipe|format|mainnet|settle|stake|transfer|escrow)\b/u.test(haystack)) {
    return "destructive";
  }
  if (/\b(write|edit|patch|chmod|chown|mv|deploy|install|network|curl|wget)\b/u.test(haystack)) {
    return "medium";
  }
  return "low";
}

export function typedConfirmationWordForRisk(input: {
  readonly risk: ApprovalRiskTier;
  readonly command?: string;
  readonly description?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
}): string {
  if (input.risk !== "destructive") return "yes";
  if (input.toolName === "CronDelete") return "delete";
  const command = input.toolInput === undefined
    ? input.command
    : approvalActionText(input.toolInput, input.toolName);
  const haystack = [command, input.description, input.toolName?.replaceAll("_", " ")].filter(Boolean).join(" ").toLowerCase();
  if (/\bsettle\b/u.test(haystack)) return "settle";
  if (/\bstake\b/u.test(haystack)) return "stake";
  if (/\btransfer\b/u.test(haystack)) return "transfer";
  if (/\b(delete|destroy|wipe)\b/u.test(haystack)) return "delete";
  if (command && commandLooksLikeRemoval(command)) return "delete";
  return "approve";
}

function approvalActionText(input: unknown, toolName: string | undefined): string | undefined {
  if (typeof input === "string") return input;
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const parts = Array.isArray(input)
    ? input.filter((part) => typeof part === "string")
    : ["command", "cmd", "script", "code", "action", "operation", "method", "edit_mode"]
      .flatMap((key) => {
        const value = record[key];
        return typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.filter((part) => typeof part === "string")
            : [];
      });
  if (parts.length > 0 && Array.isArray(record.args)) {
    parts.push(...record.args.filter((part) => typeof part === "string"));
  }
  if (toolName?.split(".").at(-1) === "write_stdin" && typeof record.chars === "string") {
    parts.push(record.chars);
  }
  if (!DATA_BEARING_BUILTIN_TOOL_NAMES.has(toolName ?? "")) {
    try {
      const serialized = JSON.stringify(input);
      if (serialized !== undefined) parts.push(serialized);
    } catch {
      parts.push(String(input));
    }
  }
  return parts.join(" ");
}

function dangerousShellCommandLabel(command: string | undefined): string | null {
  return command ? matchedDangerousShellCommandLabel(command) : null;
}

function commandLooksDestructive(command: string | undefined): boolean {
  if (!command) return false;
  return (
    dangerousShellCommandLabel(command) !== null ||
    containsRecursiveForceRemovalText(command)
  );
}

function commandLooksLikeRemoval(command: string): boolean {
  const label = dangerousShellCommandLabel(command);
  if (label === "rm -rf" || label === "rm -f") return true;
  return (
    (/\brm\b/u.test(command.toLowerCase()) && label !== null) ||
    containsRecursiveForceRemovalText(command)
  );
}

function containsRecursiveForceRemovalText(command: string): boolean {
  return (
    RECURSIVE_FORCE_RM_BUNDLED_FLAGS.test(command) ||
    RECURSIVE_FORCE_RM_SPLIT_FLAGS.test(command)
  );
}
