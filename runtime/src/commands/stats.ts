import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export function formatRuntimeStats(session: Session, cwd: string): string {
  const state = session.state.unsafePeek() as { history?: unknown[] };
  const toolCount = session.services.registry.tools.length;
  const connectedServers = session.services.mcpManager.getConnectedServers?.() ?? [];
  return [
    "AgenC stats",
    `  session: ${session.conversationId}`,
    `  cwd: ${cwd}`,
    `  transcript items: ${state.history?.length ?? 0}`,
    `  registered tools: ${toolCount}`,
    `  connected MCP servers: ${connectedServers.length}`,
  ].join("\n");
}

export const statsCommand: SlashCommand = {
  name: "stats",
  description: "Show session activity statistics",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({
      kind: "text",
      text: formatRuntimeStats(ctx.session, ctx.cwd),
    })),
};

export default statsCommand;
