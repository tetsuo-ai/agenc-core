/**
 * `/fork` — fork the current session as a new sibling thread.
 *
 * Uses the same per-session AgentControl cache as `system.agent.delegate`
 * so the slash command and tool path converge on one local control plane.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
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
  const live = await control.spawnForkedThread(
    "/root",
    { kind: "full_history" },
    {
      forkParentSpawnCallId: `slash-fork-${ctx.session.conversationId}-${randomUUID()}`,
    },
  );
  return {
    kind: "text",
    text: `Forked session ${ctx.session.conversationId} → ${live.agentId}`,
  };
}

export const forkCommand: SlashCommand = {
  name: "fork",
  description: "Fork the current session as a child thread",
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(() => runFork(ctx)),
};

export default forkCommand;
