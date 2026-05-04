import { relative } from "node:path";
import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

const FILE_KEYS = new Set(["file", "filePath", "filename", "path"]);

function looksLikePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/") ||
    /\.[A-Za-z0-9]{1,12}$/.test(value)
  );
}

function visit(value: unknown, out: Set<string>, depth: number): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (looksLikePath(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visit(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === "string" && FILE_KEYS.has(key) && looksLikePath(nested)) {
      out.add(nested);
    } else {
      visit(nested, out, depth + 1);
    }
  }
}

export function collectContextFiles(session: Session): string[] {
  const state = session.state.unsafePeek() as { history?: unknown[] };
  const files = new Set<string>();
  visit(state.history ?? [], files, 0);
  return [...files].sort((a, b) => a.localeCompare(b));
}

export function formatContextFiles(files: readonly string[], cwd: string): string {
  if (files.length === 0) return "No files in context.";
  return [
    "Files in context:",
    ...files.map(file => `  ${file.startsWith("/") ? relative(cwd, file) : file}`),
  ].join("\n");
}

export const filesCommand: SlashCommand = {
  name: "files",
  description: "List files currently referenced in session context",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({
      kind: "text",
      text: formatContextFiles(collectContextFiles(ctx.session), ctx.cwd),
    })),
};

export default filesCommand;
