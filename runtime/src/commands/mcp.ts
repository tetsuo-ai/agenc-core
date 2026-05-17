/**
 * `/mcp` — report session-owned MCP server state.
 *
 * This command reads `SessionServices.mcpManager`, the same facade used
 * by tool routing and provenance. It does not reach around the session
 * into compatibility UI/service owners.
 *
 * @module
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

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
import { openMcpMenu } from "./mcp-menu.js";

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
      readonly kind: "new";
      readonly serverName: string;
      readonly toolName: string;
      readonly description: string;
    }
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
    "       /mcp new <server> [--tool <tool>] [description...]",
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
  if (first === "new" || first === "create") {
    if (words.length < 2 || !words[1]) {
      return { kind: "error", message: usage() };
    }
    let toolName = "ping";
    const descriptionParts: string[] = [];
    for (let index = 2; index < words.length; index += 1) {
      const word = words[index];
      if (word === "--tool") {
        const next = words[index + 1];
        if (!next) return { kind: "error", message: usage() };
        toolName = next;
        index += 1;
        continue;
      }
      descriptionParts.push(word);
    }
    return {
      kind: "new",
      serverName: words[1],
      toolName,
      description:
        descriptionParts.join(" ").trim() ||
        `Return a simple response from ${words[1]}.`,
    };
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
  toolsByServer?: ReadonlyMap<string, readonly McpToolStatus[]>,
): string {
  if (servers.length === 0) {
    return [
      "MCP servers: none configured.",
      "Use `/mcp add <server> <command> [args...]` for this session, or `agenc mcp add` to persist one.",
    ].join("\n");
  }
  const lines = ["MCP servers:"];
  for (const server of servers) {
    const state = server.enabled ? "connected" : "disconnected";
    const required = server.required ? " required" : "";
    const target = server.url ?? server.command ?? "local";
    const tools = toolsByServer?.get(server.name);
    const toolCount =
      tools !== undefined
        ? `, ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`
        : "";
    lines.push(`  ${server.name}: ${state}${required} (${target}${toolCount})`);
    if (tools !== undefined && tools.length > 0) {
      const preview = tools.slice(0, 3).map((tool) => tool.name).join(", ");
      const overflow = tools.length > 3 ? `, +${tools.length - 3} more` : "";
      lines.push(`    tools: ${preview}${overflow}`);
    }
  }
  if (toolsByServer !== undefined) {
    lines.push("Use `/mcp tools [server]` for descriptions.");
  }
  return lines.join("\n");
}

export interface McpToolStatus {
  readonly name: string;
  readonly description?: string;
}

const MAX_MCP_TOOL_ROW_WIDTH = 76;

function toolStatusFromTool(tool: McpSessionToolInfo): McpToolStatus {
  const description =
    typeof tool.description === "string"
      ? sanitizeMcpToolText(stripMcpToolInvocationMetadata(tool.description))
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

function stripMcpToolInvocationMetadata(value: string): string {
  const marker = value.search(
    /\bModel-facing function name:|\bCanonical MCP tool name:|\bCall this only through\b/u,
  );
  return marker === -1 ? value : value.slice(0, marker).trim();
}

function compactMcpText(value: string, limit: number): string {
  const normalized = sanitizeMcpToolText(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function validateMcpServerName(name: string): string | null {
  return /^[A-Za-z0-9_-]+$/u.test(name) ? name : null;
}

function validateMcpToolName(name: string): string | null {
  return /^[A-Za-z][A-Za-z0-9_-]*$/u.test(name) ? name : null;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function mcpServerTemplate(
  serverName: string,
  toolName: string,
  description: string,
): string {
  const responseText = `Hello from ${serverName}. ${description}`;
  return `#!/usr/bin/env node

const serverName = ${jsonString(serverName)};
const toolName = ${jsonString(toolName)};
const toolDescription = ${jsonString(description)};
const toolResponse = ${jsonString(responseText)};

let buffer = Buffer.alloc(0);

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || !Object.hasOwn(message, "id")) {
    return;
  }

  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: serverName, version: "0.1.0" },
    });
    return;
  }

  if (message.method === "tools/list") {
    result(message.id, {
      tools: [
        {
          name: toolName,
          description: toolDescription,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }

  if (message.method === "tools/call") {
    if (message.params?.name !== toolName) {
      error(message.id, -32602, \`Unknown tool: \${String(message.params?.name ?? "")}\`);
      return;
    }
    result(message.id, {
      content: [{ type: "text", text: toolResponse }],
    });
    return;
  }

  error(message.id, -32601, \`Unknown method: \${String(message.method ?? "")}\`);
}

function drain() {
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline === -1) return;

    const body = buffer.subarray(0, newline).toString("utf8").replace(/\\r$/, "");
    buffer = buffer.subarray(newline + 1);
    if (body.trim().length === 0) continue;
    try {
      handle(JSON.parse(body));
    } catch (caught) {
      console.error(caught instanceof Error ? caught.message : String(caught));
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
`;
}

export async function createProjectMcpServer(
  cwd: string,
  serverNameRaw: string,
  toolNameRaw: string,
  descriptionRaw: string,
): Promise<
  | {
      readonly serverName: string;
      readonly toolName: string;
      readonly scriptFile: string;
      readonly relativeScriptFile: string;
    }
  | { readonly error: string }
> {
  const serverName = validateMcpServerName(serverNameRaw);
  if (serverName === null) {
    return {
      error:
        "Invalid MCP server name. Use only letters, numbers, hyphens, and underscores.",
    };
  }
  const toolName = validateMcpToolName(toolNameRaw);
  if (toolName === null) {
    return {
      error:
        "Invalid MCP tool name. Start with a letter and use only letters, numbers, hyphens, and underscores.",
    };
  }
  const description =
    descriptionRaw.trim() || `Return a simple response from ${serverName}.`;
  const serverDir = join(cwd, ".agenc", "mcp");
  const scriptFile = join(serverDir, `${serverName}.mjs`);
  await mkdir(serverDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      scriptFile,
      mcpServerTemplate(serverName, toolName, description),
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        error: `MCP server file already exists: ${relative(cwd, scriptFile)}`,
      };
    }
    throw error;
  }
  return {
    serverName,
    toolName,
    scriptFile,
    relativeScriptFile: relative(cwd, scriptFile),
  };
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

export function collectMcpToolStatusByServer(
  session: Session,
  servers: ReadonlyArray<McpServerStatus>,
): ReadonlyMap<string, readonly McpToolStatus[]> {
  const getToolsByServer = session.services.mcpManager.getToolsByServer?.bind(
    session.services.mcpManager,
  );
  if (getToolsByServer === undefined) return new Map();

  const toolsByServer = new Map<string, McpToolStatus[]>();
  for (const server of servers) {
    toolsByServer.set(
      server.name,
      getToolsByServer(server.name)
        .map(toolStatusFromTool)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
  return toolsByServer;
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
    if (description.length === 0) {
      lines.push(`  ${name}`);
      continue;
    }
    const prefix = `  ${name} - `;
    const available = Math.max(0, MAX_MCP_TOOL_ROW_WIDTH - prefix.length);
    lines.push(
      available >= 16
        ? `${prefix}${compactMcpText(description, available)}`
        : `  ${name}`,
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
        const toolsByServer = collectMcpToolStatusByServer(ctx.session, servers);
        if (openMcpMenu(ctx, servers, toolsByServer)) {
          return { kind: "skip" };
        }
        return {
          kind: "text",
          text: formatMcpServerStatus(servers, toolsByServer),
        };
      }
      if (parsed.kind === "tools") {
        const tools = collectMcpToolStatus(ctx.session, parsed.serverName);
        return {
          kind: "text",
          text: formatMcpToolStatus(tools, parsed.serverName),
        };
      }
      const manager = ctx.session.services.mcpManager;
      if (parsed.kind === "new") {
        const scaffold = await createProjectMcpServer(
          ctx.cwd,
          parsed.serverName,
          parsed.toolName,
          parsed.description,
        );
        if ("error" in scaffold) {
          return { kind: "error", message: scaffold.error };
        }
        const add = manager.addServer;
        const sessionCommand =
          `/mcp add ${scaffold.serverName} node ${scaffold.relativeScriptFile}`;
        const persistCommand =
          `agenc mcp add ${scaffold.serverName} node ${scaffold.relativeScriptFile}`;
        if (typeof add !== "function") {
          return {
            kind: "text",
            text: [
              `Created MCP server: ${scaffold.relativeScriptFile}`,
              `Tool: ${scaffold.toolName}`,
              `Add this session: ${sessionCommand}`,
              `Persist later: ${persistCommand}`,
            ].join("\n"),
          };
        }
        const result = await add({
          name: scaffold.serverName,
          transport: "stdio",
          command: "node",
          args: [scaffold.scriptFile],
          enabled: true,
        });
        if (!result.success) {
          return {
            kind: "error",
            message: [
              `Created MCP server: ${scaffold.relativeScriptFile}`,
              `Could not connect it: ${result.error ?? "unknown MCP add failure"}`,
              `Try after editing: ${sessionCommand}`,
            ].join("\n"),
          };
        }
        const toolCount =
          result.toolCount > 0
            ? ` (${result.toolCount} ${
                result.toolCount === 1 ? "tool" : "tools"
              })`
            : "";
        return {
          kind: "text",
          text: [
            `Created MCP server: ${scaffold.relativeScriptFile}`,
            `Connected for this session${toolCount}: /mcp tools ${
              scaffold.serverName
            }`,
            `Tool: ${scaffold.toolName}`,
            `Persist later: ${persistCommand}`,
          ].join("\n"),
        };
      }
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
