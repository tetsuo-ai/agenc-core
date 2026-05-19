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
      // Bridge sessions (TUI client → daemon) don't have a local
      // `shutdown()` to call — the daemon owns the session and will
      // tear it down when the TUI client disconnects. Skip the call
      // gracefully when the method is absent rather than crashing
      // `/exit` with `ctx.session.shutdown is not a function`.
      const shutdown = (ctx.session as unknown as {
        shutdown?: () => Promise<void> | void;
      }).shutdown;
      if (typeof shutdown === "function") {
        await shutdown.call(ctx.session);
      }
      return { kind: "exit", code: 0 };
    }),
};
