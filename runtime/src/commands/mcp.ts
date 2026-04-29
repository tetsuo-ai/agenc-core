/**
 * `/mcp` — report session-owned MCP server state.
 *
 * This command reads `SessionServices.mcpManager`, the same facade used
 * by tool routing and provenance. It does not reach around the session
 * into legacy UI/service owners.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export interface McpServerStatus {
  readonly name: string;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly url?: string;
  readonly command?: string;
}

function parseArgs(argsRaw: string): "status" | null {
  const first = argsRaw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first === "" || first === "status" || first === "list") return "status";
  return null;
}

export async function collectMcpServerStatus(
  session: Session,
): Promise<McpServerStatus[]> {
  const manager = session.services.mcpManager;
  const servers = await manager.effectiveServers(
    session.config,
    session.services.authManager,
  );
  return [...servers.entries()]
    .map(([name, info]) => ({
      name,
      enabled: info.enabled,
      required: info.required,
      ...(info.url !== undefined ? { url: info.url } : {}),
      ...(info.command !== undefined ? { command: info.command } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function formatMcpServerStatus(
  servers: ReadonlyArray<McpServerStatus>,
): string {
  if (servers.length === 0) return "MCP servers: none configured.";
  const lines = ["MCP servers:"];
  for (const server of servers) {
    const state = server.enabled ? "connected" : "disconnected";
    const required = server.required ? " required" : "";
    const target = server.url ?? server.command ?? "local";
    lines.push(`  ${server.name}: ${state}${required} (${target})`);
  }
  return lines.join("\n");
}

export const mcpCommand: SlashCommand = {
  name: "mcp",
  description: "Show MCP server connection status",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      if (parseArgs(ctx.argsRaw) === null) {
        return { kind: "error", message: "Usage: /mcp [status|list]" };
      }
      const servers = await collectMcpServerStatus(ctx.session);
      return { kind: "text", text: formatMcpServerStatus(servers) };
    }),
};

export default mcpCommand;
