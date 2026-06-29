/**
 * `/init` - initialize project-level AgenC files from local repository analysis.
 */

import {
  formatProjectInitResult,
  initializeAgenCProject,
} from "../config/project-init.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

function parseInitArgs(argsRaw: string): { readonly force: boolean } | string {
  const args = argsRaw.split(/\s+/).filter((arg) => arg.length > 0);
  let force = false;
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") {
      force = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return "Usage: /init [--force]";
    }
    return `Unknown /init argument: ${arg}. Try /init --help.`;
  }
  return { force };
}

export const initCommand: SlashCommand = {
  name: "init",
  description: "Analyze this repository and write .agenc/config.json plus AGENC.md",
  immediate: true,
  userInvocable: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const parsed = parseInitArgs(ctx.argsRaw.trim());
      if (typeof parsed === "string") {
        return { kind: "text", text: parsed };
      }
      const result = await initializeAgenCProject({
        cwd: ctx.cwd,
        force: parsed.force,
      });
      return { kind: "text", text: formatProjectInitResult(result) };
    }),
};
