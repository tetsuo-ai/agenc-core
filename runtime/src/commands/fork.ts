/**
 * `/fork` — fork the current session as a new sibling thread.
 *
 * Uses the live T9 `AgentControl.spawnForkedThread(...)` path under the
 * session root. User-triggered forks do not originate from a model
 * `spawn_agent` tool call, so we synthesize a stable parent spawn-call id
 * from the session's internal sub-id allocator.
 *
 * @module
 */

import { ensureAgentControl } from "../bin/delegate-tool.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export async function runFork(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const { control } = ensureAgentControl(ctx.session);
  const child = await control.spawnForkedThread(
    "/root",
    { kind: "full_history" },
    { forkParentSpawnCallId: ctx.session.nextInternalSubId() },
  );
  return {
    kind: "text",
    text: `Forked session ${ctx.session.conversationId} → ${child.agentId}`,
  };
}

export const forkCommand: SlashCommand = {
  name: "fork",
  description: "Fork the current session as a sibling thread",
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(() => runFork(ctx)),
};

export default forkCommand;
