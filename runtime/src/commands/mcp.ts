/**
 * `/mcp` — report session-owned MCP server state.
 *
 * This command reads `SessionServices.mcpManager`, the same facade used
 * by tool routing and provenance. It does not reach around the session
 * into compatibility UI/service owners.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type {
  McpServerMutationResult,
  McpSessionToolInfo,
} from "../session/session.js";
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

type ParsedMcpArgs =
  | { readonly kind: "status" }
  | { readonly kind: "tools"; readonly serverName?: string }
  | { readonly kind: "reconnect"; readonly serverName: string }
  | { readonly kind: "enable"; readonly serverName: string }
  | { readonly kind: "disable"; readonly serverName: string }
  | {
      readonly kind: "add";
      readonly serverName: string;
      readonly command: string;
      readonly args: readonly string[];
    }
  | { readonly kind: "error"; readonly message: string };

function usage(): string {
  return [
    "Usage: /mcp [status|list]",
    "       /mcp tools [server]",
    "       /mcp reconnect <server>",
    "       /mcp enable <server>",
    "       /mcp disable <server>",
    "       /mcp add <server> <command> [args...]",
  ].join("\n");
}

function parseShellWords(input: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  let sawToken = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      sawToken = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      sawToken = true;
      continue;
    }
    if ((char === "'" || char === "\"") && quote === null) {
      quote = char;
      sawToken = true;
      continue;
    }
    if (char === quote) {
      quote = null;
      sawToken = true;
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (sawToken) {
        words.push(current);
        current = "";
        sawToken = false;
      }
      continue;
    }
    current += char;
    sawToken = true;
  }

  if (escaping || quote !== null) return null;
  if (sawToken) words.push(current);
  return words;
}

export function parseMcpArgs(argsRaw: string): ParsedMcpArgs {
  const words = parseShellWords(argsRaw.trim());
  if (words === null) {
    return { kind: "error", message: `${usage()}\nInvalid quoting in /mcp arguments.` };
  }
  const first = words[0]?.toLowerCase() ?? "";
  if (first === "" || first === "status" || first === "list") {
    if (words.length > (first === "" ? 0 : 1)) {
      return { kind: "error", message: usage() };
    }
    return { kind: "status" };
  }
  if (first === "tools") {
    if (words.length > 2) return { kind: "error", message: usage() };
    return words[1] ? { kind: "tools", serverName: words[1] } : { kind: "tools" };
  }
  if (first === "reconnect" || first === "enable" || first === "disable") {
    if (words.length !== 2 || !words[1]) return { kind: "error", message: usage() };
    return { kind: first, serverName: words[1] };
  }
  if (first === "add") {
    if (words.length < 3 || !words[1] || !words[2]) {
      return { kind: "error", message: usage() };
    }
    return {
      kind: "add",
      serverName: words[1],
      command: words[2],
      args: words.slice(3),
    };
  }
  return { kind: "error", message: usage() };
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

export interface McpToolStatus {
  readonly name: string;
  readonly description?: string;
}

function toolStatusFromTool(tool: McpSessionToolInfo): McpToolStatus {
  const description =
    typeof tool.description === "string"
      ? sanitizeMcpToolText(tool.description)
      : "";
  return {
    name: sanitizeMcpToolText(tool.name) || "(unnamed tool)",
    ...(description.length > 0
      ? { description }
      : {}),
  };
}

function sanitizeMcpToolText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "?")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function collectMcpToolStatus(
  session: Session,
  serverName?: string,
): McpToolStatus[] {
  const manager = session.services.mcpManager;
  const tools =
    serverName !== undefined
      ? manager.getToolsByServer?.(serverName)
      : manager.getTools?.();
  if (tools === undefined) {
    throw new Error("MCP tool listing is not available for this session.");
  }
  return tools.map(toolStatusFromTool).sort((a, b) => a.name.localeCompare(b.name));
}

export function formatMcpToolStatus(
  tools: ReadonlyArray<McpToolStatus>,
  serverName?: string,
): string {
  if (tools.length === 0) {
    return serverName
      ? `MCP tools for ${serverName}: none available.`
      : "MCP tools: none available.";
  }
  const lines = [
    serverName ? `MCP tools for ${serverName}:` : "MCP tools:",
  ];
  for (const tool of tools) {
    const name = sanitizeMcpToolText(tool.name) || "(unnamed tool)";
    const description =
      tool.description !== undefined
        ? sanitizeMcpToolText(tool.description)
        : "";
    lines.push(
      `  ${name}${description ? ` - ${description}` : ""}`,
    );
  }
  return lines.join("\n");
}

function formatMutationResult(
  action: string,
  result: McpServerMutationResult,
  successSuffix: string,
): SlashCommandResult {
  if (!result.success) {
    return {
      kind: "error",
      message: result.error ?? `MCP server "${result.serverName}" ${action} failed.`,
    };
  }
  return {
    kind: "text",
    text: `MCP server "${result.serverName}" ${successSuffix}${
      result.toolCount > 0 ? ` (${result.toolCount} tools)` : ""
    }.`,
  };
}

function requireMcpMethod<T>(
  method: T | undefined,
  action: string,
): T {
  if (typeof method !== "function") {
    throw new Error(`MCP ${action} is not available for this session.`);
  }
  return method;
}

export const mcpCommand: SlashCommand = {
  name: "mcp",
  description: "Show and manage MCP servers",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const parsed = parseMcpArgs(ctx.argsRaw);
      if (parsed.kind === "error") {
        return { kind: "error", message: parsed.message };
      }
      if (parsed.kind === "status") {
        const servers = await collectMcpServerStatus(ctx.session);
        return { kind: "text", text: formatMcpServerStatus(servers) };
      }
      if (parsed.kind === "tools") {
        const tools = collectMcpToolStatus(ctx.session, parsed.serverName);
        return {
          kind: "text",
          text: formatMcpToolStatus(tools, parsed.serverName),
        };
      }
      const manager = ctx.session.services.mcpManager;
      if (parsed.kind === "reconnect") {
        const reconnect = requireMcpMethod(
          manager.reconnectServer,
          "reconnect",
        );
        return formatMutationResult(
          "reconnect",
          await reconnect(parsed.serverName),
          "reconnected",
        );
      }
      if (parsed.kind === "enable") {
        const enable = requireMcpMethod(manager.enableServer, "enable");
        return formatMutationResult(
          "enable",
          await enable(parsed.serverName),
          "enabled for this session",
        );
      }
      if (parsed.kind === "disable") {
        const disable = requireMcpMethod(manager.disableServer, "disable");
        return formatMutationResult(
          "disable",
          await disable(parsed.serverName),
          "disabled for this session",
        );
      }
      if (parsed.kind === "add") {
        const add = requireMcpMethod(manager.addServer, "add");
        const result = await add({
          name: parsed.serverName,
          transport: "stdio",
          command: parsed.command,
          args: parsed.args,
          enabled: true,
        });
        const formatted = formatMutationResult(
          "add",
          result,
          "added for this session",
        );
        return formatted.kind === "text"
          ? {
              kind: "text",
              text:
                `${formatted.text}\n` +
                "This does not edit config.toml. Use `agenc mcp add` to persist the server.",
            }
          : formatted;
      }
      return { kind: "error", message: usage() };
    }),
};

export default mcpCommand;
