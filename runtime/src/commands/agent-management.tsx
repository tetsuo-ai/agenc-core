/**
 * `/agents` — open the interactive agent management surface.
 *
 * This is the runtime slash-command bridge for the moved local-JSX
 * `commands/agents` implementation. It is intentionally TUI-only: headless
 * dispatch returns a clear error instead of pretending an interactive menu can
 * render.
 */

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import { openAgentsMenu } from "./agents-menu.js";

export const agentsCommand: SlashCommand = {
  name: "agents",
  description: "Manage agents — opens a picker",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      if (!openAgentsMenu(ctx)) {
        return {
          kind: "error",
          message: "/agents requires the interactive TUI.",
        };
      }
      return { kind: "skip" };
    }),
};
