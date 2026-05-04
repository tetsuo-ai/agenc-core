import { relative } from "node:path";
import type { Session } from "../session/session.js";
import { forEachSessionRead } from "../tools/system/filesystem.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export function collectContextFiles(session: Session): string[] {
  const files = new Set<string>();
  forEachSessionRead(session.conversationId, (file, snapshot) => {
    if (snapshot.isPartialView !== true) files.add(file);
  });
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
  isEnabled: () => process.env.USER_TYPE === "ant",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({
      kind: "text",
      text: formatContextFiles(collectContextFiles(ctx.session), ctx.cwd),
    })),
};

export default filesCommand;
