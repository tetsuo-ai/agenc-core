import { nonEmptyString } from "../utils/stringUtils.js";

const COMMAND_KEYS = ["command", "cmd"] as const;
const TEXT_KEYS = ["input", "query", "path", "file_path"] as const;

export interface ApprovalInputTextOptions {
  readonly prettyJson?: boolean;
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
