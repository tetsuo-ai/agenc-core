import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export function formatRuntimeStats(session: Session, cwd: string): string {
  // Bridge sessions (TUI client → daemon) don't expose `state`,
  // `services.registry`, or `services.mcpManager` directly — those
  // live on the daemon-side in-process Session. Guard the accesses
  // so `/stats` degrades to "n/a" lines instead of crashing with a
  // raw `Cannot read properties of undefined (reading 'unsafePeek')`.
  const peekState = (session as unknown as {
    state?: { unsafePeek?: () => unknown };
  }).state?.unsafePeek;
  const state =
    typeof peekState === "function"
      ? (peekState.call((session as unknown as { state?: unknown }).state) as {
          history?: unknown[];
        })
      : null;
  const services = (session as unknown as {
    services?: {
      registry?: { tools?: ReadonlyArray<unknown> };
      mcpManager?: { getConnectedServers?: () => ReadonlyArray<unknown> };
    };
  }).services;
  const toolCount = services?.registry?.tools?.length ?? null;
  const connectedServers = services?.mcpManager?.getConnectedServers?.() ?? null;
  return [
    "AgenC stats",
    `  session: ${session.conversationId}`,
    `  cwd: ${cwd}`,
    `  transcript items: ${
      state?.history?.length ?? "n/a (daemon-owned)"
    }`,
    `  registered tools: ${toolCount ?? "n/a (daemon-owned)"}`,
    `  connected MCP servers: ${
      connectedServers === null ? "n/a (daemon-owned)" : connectedServers.length
    }`,
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
