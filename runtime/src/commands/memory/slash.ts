import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "../types.js";

const MEMORY_CLI_SURFACE = "agenc memory";

/**
 * Headless dispatcher fallback for `/memory`.
 *
 * The interactive TUI command is exported from `index.ts` as a local JSX
 * command. The registry still needs a plain SlashCommand so daemon/headless
 * dispatch has a non-throwing answer instead of trying to render Ink.
 */
export const memorySlashCommand: SlashCommand = {
  name: "memory",
  description: "Open AgenC memory editor",
  userInvocable: true,
  immediate: true,
  execute: (_ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({
      kind: "text",
      text:
        `The ${MEMORY_CLI_SURFACE} editor is available in the interactive TUI. ` +
        "Run /memory there to choose and edit memory files.",
    })),
};

export default memorySlashCommand;
