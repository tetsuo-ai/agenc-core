import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

function wikiDir(cwd: string): string {
  return join(cwd, ".agenc", "wiki");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function handleWikiCommand(cwd: string, argsRaw: string): Promise<string> {
  const action = argsRaw.trim().toLowerCase() || "status";
  const dir = wikiDir(cwd);
  if (action === "status") {
    return (await exists(dir))
      ? `Project wiki initialized at ${dir}`
      : "Project wiki is not initialized. Run /wiki init to create it.";
  }
  if (action === "init") {
    await mkdir(dir, { recursive: true });
    const readme = join(dir, "README.md");
    if (!(await exists(readme))) {
      await writeFile(readme, "# AgenC Project Wiki\n\n", "utf8");
    }
    return `Project wiki initialized at ${dir}`;
  }
  return "Usage: /wiki [status|init]";
}

export const wikiCommand: SlashCommand = {
  name: "wiki",
  description: "Initialize or inspect the AgenC project wiki",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({
      kind: "text",
      text: await handleWikiCommand(ctx.cwd, ctx.argsRaw),
    })),
};

export default wikiCommand;
