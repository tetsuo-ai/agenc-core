import { nonEmptyString } from "../utils/stringUtils.js";

const COMMAND_KEYS = ["command", "cmd"] as const;
const TEXT_KEYS = ["input", "query", "path", "file_path"] as const;

/** Live shell/command tool names whose approval input IS a runnable command. */
const SHELL_COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "system.bash",
  "exec_command",
  "Run",
]);

export interface ApprovalInputTextOptions {
  readonly prettyJson?: boolean;
  /** The requesting tool: text it types into a running process reads as the shell input it is. */
  readonly toolName?: string;
}

/**
 * The text `write_stdin` types into a session that `exec_command` left
 * running. A shell running there executes it, so the card shows it as the
 * command it is.
 */
function stdinText(toolName: string | undefined, record: Record<string, unknown>): string | null {
  return toolName?.split(".").at(-1) === "write_stdin" ? textValue(record.chars) : null;
}

/**
 * Whether the card shows a call's input as shell input: exactly as given,
 * behind the `$ ` prompt glyph. A shell does not expand a quoted `~`, so a
 * shortened home path could read as a different command. True for the shell
 * tools, for any input that carries a `command` or `cmd`, and for text typed
 * into a running process; a file tool's path is not shell input.
 */
export function approvalInputIsShell(toolName: string | undefined, input: unknown): boolean {
  if (toolName !== undefined && SHELL_COMMAND_TOOL_NAMES.has(toolName)) return true;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return typeof record.command === "string" || typeof record.cmd === "string" ||
    stdinText(toolName, record) !== null;
}

export function approvalInputText(
  input: unknown,
  options: ApprovalInputTextOptions = {},
): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);

  if (Array.isArray(input)) {
    return scalarArrayText(input) ?? fallbackText(input, options);
  }

  const record = input as Record<string, unknown>;
  const command = commandText(record);
  if (command !== null) return command;
  const stdin = stdinText(options.toolName, record);
  if (stdin !== null) return stdin;

  for (const key of TEXT_KEYS) {
    const value = textValue(record[key]);
    if (value !== null) return value;
  }

  return fallbackText(record, options);
}

function commandText(record: Record<string, unknown>): string | null {
  const args = Array.isArray(record.args)
    ? commandArrayParts(record.args)
    : [];
  for (const key of COMMAND_KEYS) {
    const command = commandParts(record[key]);
    if (command.length > 0) {
      return [...command, ...args].join(" ");
    }
  }
  return null;
}

function commandParts(value: unknown): readonly string[] {
  if (Array.isArray(value)) return commandArrayParts(value);
  const text = textValue(value);
  return text === null ? [] : [text];
}

function commandArrayParts(value: readonly unknown[]): readonly string[] {
  const parts: string[] = [];
  for (const item of value) {
    const text = textValue(item);
    parts.push(text ?? fallbackText(item, { prettyJson: false }));
  }
  return parts;
}

function scalarArrayText(value: readonly unknown[]): string | null {
  const parts = scalarArrayParts(value);
  return parts === null ? null : parts.join(" ");
}

function scalarArrayParts(value: readonly unknown[]): readonly string[] | null {
  const parts: string[] = [];
  for (const item of value) {
    const text = textValue(item);
    if (text === null) return null;
    parts.push(text);
  }
  return parts.length > 0 ? parts : null;
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") {
    return nonEmptyString(value) ?? null;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return null;
}

function fallbackText(value: unknown, options: ApprovalInputTextOptions): string {
  try {
    const json = JSON.stringify(value, null, options.prettyJson ? 2 : undefined);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
