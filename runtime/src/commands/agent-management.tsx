/**
 * `/agents` — open the interactive agent management surface.
 *
 * This is the runtime slash-command bridge for the moved local-JSX
 * `commands/agents` implementation. It is intentionally TUI-only: headless
 * dispatch returns a clear error instead of pretending an interactive menu can
 * render.
 */

import * as React from "react";

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export const agentsCommand: SlashCommand = {
  name: "agents",
  description: "Manage agent configurations",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const setToolJSX = ctx.appState?.setToolJSX;
      if (typeof setToolJSX !== "function") {
        return {
          kind: "error",
          message: "/agents requires the interactive TUI.",
        };
      }

      const { AgentsMenu } = await import(
        "../tui/components/agents/AgentsMenu.js"
      );
      const tools = Array.isArray(ctx.appState?.tools)
        ? ctx.appState.tools
        : [];
      setToolJSX({
        isLocalJSXCommand: true,
        jsx: (
          <AgentsMenu
            tools={tools as never}
            onExit={() => {
              setToolJSX(null);
            }}
          />
        ),
      });
      return { kind: "skip" };
    }),
};

export default agentsCommand;
