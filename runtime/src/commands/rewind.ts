/**
 * `/rewind` — open the rewind dialog (message selector).
 *
 * Restores the code and/or conversation to the point before a prior
 * prompt. The dialog itself is the TUI's message selector (also bound
 * to a keybinding); this command exists for discoverability — the
 * restore machinery ships with the daemon-backed session
 * (`session.previewFileRewind` / `session.rewindFilesToMessage`).
 *
 * In headless contexts (no TUI bridge) it reports how to reach the
 * dialog instead of failing.
 *
 * @module
 */

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export const rewindCommand: SlashCommand = {
  name: "rewind",
  description: "Restore the code and/or conversation to a previous point",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const openSelector = ctx.appState?.requestShowMessageSelector;
      if (typeof openSelector === "function") {
        openSelector();
        return { kind: "skip" };
      }
      return {
        kind: "text",
        text: "Rewind requires the interactive TUI (it opens the rewind dialog). Start `agenc` without --print and run /rewind there.",
      };
    }),
};
