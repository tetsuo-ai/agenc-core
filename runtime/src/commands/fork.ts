/**
 * `/fork` — fork the current session as a new sibling thread.
 *
 * The real fork path routes through T9's `spawnForkedThread` /
 * `delegate()` on `AgentControl`. W1 lands this stub so the command is
 * discoverable and dispatch-safe; the actual fork wiring lives in W3.
 *
 * @module
 */

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

/** Attempt the fork; returns a stub result when the T9 API is absent. */
export async function runFork(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const agentControl = ctx.session.services?.agentControl as unknown as
    | {
        spawnForkedThread?: (opts: unknown) => Promise<unknown>;
      }
    | undefined;

  if (!agentControl || typeof agentControl.spawnForkedThread !== "function") {
    return {
      kind: "text",
      text:
        "fork requires T9 spawnForkedThread which is pending integration. " +
        "See W3 for the fork-reconstruction tranche.",
    };
  }

  // If a real spawnForkedThread exists, invoke it best-effort. Surfaces
  // its identifier when available.
  const result = (await agentControl.spawnForkedThread({
    source: ctx.session.conversationId,
  })) as { threadId?: string } | undefined;
  const threadId = result?.threadId ?? "unknown";
  return {
    kind: "text",
    text: `Forked session ${ctx.session.conversationId} → ${threadId}`,
  };
}

export const forkCommand: SlashCommand = {
  name: "fork",
  description: "Fork the current session (W3 wires real reconstruction)",
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(() => runFork(ctx)),
};

export default forkCommand;
