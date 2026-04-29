/**
 * `/memory` — inspect and control session memory mode.
 *
 * This command intentionally controls the current session only. Durable
 * memory files remain on disk unless the user explicitly runs
 * `/memory clear --confirm`.
 *
 * @module
 */

import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  consolidateMemoryFiles,
  getSessionMemoryMode,
  memoryLayout,
  parseMemoryMode,
  setSessionMemoryMode,
} from "../prompts/memory/index.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

function usage(): string {
  return [
    "Usage: /memory [status|on|off|polluted|summarize|clear --confirm]",
    "",
    "Modes:",
    "- on/enabled: memory recall and writes are enabled",
    "- off/disabled: memory recall and writes are disabled for this session",
    "- polluted: memory recall remains available, but this session will not write durable memory",
  ].join("\n");
}

async function summarize(ctx: SlashCommandContext): Promise<SlashCommandResult> {
  if (!ctx.agencHome) {
    return { kind: "error", message: "AgenC home is not available." };
  }
  const layout = memoryLayout(join(ctx.agencHome, "memory"));
  await consolidateMemoryFiles(layout.root);
  try {
    const summary = await readFile(layout.memorySummaryPath, "utf8");
    return { kind: "text", text: summary.trim() || "No memory summary yet." };
  } catch {
    return { kind: "text", text: "No memory summary yet." };
  }
}

export const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Inspect or change this session's memory mode",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const args = ctx.argsRaw.trim().split(/\s+/).filter(Boolean);
      const action = args[0]?.toLowerCase() ?? "status";

      if (action === "status") {
        return {
          kind: "text",
          text: `Memory mode: ${getSessionMemoryMode(ctx.session)}`,
        };
      }

      if (action === "summarize" || action === "summary") {
        return summarize(ctx);
      }

      if (action === "clear") {
        if (args[1] !== "--confirm") {
          return {
            kind: "error",
            message: "Refusing to clear memory without --confirm.",
          };
        }
        if (!ctx.agencHome) {
          return { kind: "error", message: "AgenC home is not available." };
        }
        await rm(memoryLayout(join(ctx.agencHome, "memory")).root, {
          recursive: true,
          force: true,
        });
        return { kind: "text", text: "Cleared durable memory files." };
      }

      const mode = parseMemoryMode(action);
      if (mode === null) {
        return { kind: "error", message: usage() };
      }
      setSessionMemoryMode(ctx.session, mode);
      return {
        kind: "text",
        text: `Memory mode set to ${mode}.`,
      };
    }),
};

export default memoryCommand;
