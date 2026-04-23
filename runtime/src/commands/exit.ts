/**
 * `/exit` — graceful session shutdown.
 *
 * Calls `session.shutdown()` (drains child mailboxes, flushes rollout,
 * closes the event log) and returns an `exit` result so the CLI can
 * `process.exit(0)` from its dispatcher.
 *
 * Alias `/quit`.
 *
 * @module
 */

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export const exitCommand: SlashCommand = {
  name: "exit",
  aliases: ["quit"],
  description: "Shut down the session cleanly and exit",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      await ctx.session.shutdown();
      return { kind: "exit", code: 0 };
    }),
};

export default exitCommand;
