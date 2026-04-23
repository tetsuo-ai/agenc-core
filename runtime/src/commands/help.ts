/**
 * `/help` — list registered slash commands.
 *
 * Reads the global command registry (installed by the dispatcher in W1-F).
 * Until the registry is wired, emits a "registry pending" notice so the
 * command itself is safe to land standalone.
 *
 * @module
 */

import {
  getGlobalCommandRegistry,
  safeExecute,
  type CommandRegistry,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

/**
 * Format the registry as a plain-text help block:
 *   /name, /alias1, /alias2 — description
 */
export function formatHelp(reg: CommandRegistry): string {
  const cmds = reg.list().filter((c) => c.userInvocable !== false);
  if (cmds.length === 0) return "No slash commands registered.";
  const lines: string[] = ["Available commands:"];
  // Sort alphabetically for stable output.
  const sorted = [...cmds].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of sorted) {
    const names = [c.name, ...(c.aliases ?? [])].map((n) => `/${n}`).join(", ");
    lines.push(`  ${names} — ${c.description}`);
  }
  return lines.join("\n");
}

export const helpCommand: SlashCommand = {
  name: "help",
  description: "Show available slash commands",
  immediate: true,
  execute: (_ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const reg = getGlobalCommandRegistry();
      if (!reg) {
        return { kind: "text", text: "registry pending" };
      }
      return { kind: "text", text: formatHelp(reg) };
    }),
};

export default helpCommand;
