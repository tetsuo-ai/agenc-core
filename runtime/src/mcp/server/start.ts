/**
 * Config-backed MCP server start contract.
 *
 * CF-11 anchors `mcp.server` at the runtime start boundary so both the
 * user-facing `agenc mcp serve` command and daemon autostart read the same
 * transport, host, and port defaults before opening real transports.
 */

import type { Server } from "node:http";
import { cwd as processCwd } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { AgenCConfig, McpServerModeConfig } from "../../config/schema.js";
import { VERSION } from "../../index.js";
import { McpServerFramework } from "../../mcp-server/framework.js";
import { McpHttpSseServerTransport } from "../../mcp-server/http-sse.js";
import { McpStdioServerTransport } from "../../mcp-server/stdio.js";
import { mcpToolRegistryFromAgenCTools } from "../../mcp-server/tools.js";
import {
  buildToolRegistry,
  type ToolRegistry,
} from "../../tool-registry.js";

export interface McpServerStartIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface McpServerStartOptions {
  readonly cwd?: string;
  readonly io?: McpServerStartIo;
  readonly toolRegistry?: ToolRegistry;
}

export interface McpServerStartCommand {
  readonly transport: "stdio" | "sse";
  readonly host: string;
  readonly port: number;
}

export interface StartedMcpSseServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
  waitUntilClosed(): Promise<void>;
}

export interface ResolvedMcpServeDefaults {
  readonly enabled: boolean;
  readonly transport: "stdio" | "sse";
  readonly host: string;
  readonly port: number;
}

export type ConfiguredMcpServerStartResult =
  | {
      readonly kind: "disabled";
      readonly defaults: ResolvedMcpServeDefaults;
    }
  | {
      readonly kind: "unsupported";
      readonly defaults: ResolvedMcpServeDefaults;
      readonly reason: string;
    }
  | {
      readonly kind: "started";
      readonly defaults: ResolvedMcpServeDefaults;
      readonly server: StartedMcpSseServer;
    };

export function resolveMcpServeDefaults(
  config: McpServerModeConfig | undefined,
): ResolvedMcpServeDefaults {
  return {
    enabled: config?.enabled === true,
    transport: config?.transport === "sse" ? "sse" : "stdio",
    host: readMcpServeHost(config?.host),
    port: readMcpServePort(config?.port),
  };
}

export async function startMcpServerFromConfig(
  config: Pick<AgenCConfig, "mcp"> | undefined,
  options: McpServerStartOptions = {},
): Promise<ConfiguredMcpServerStartResult> {
  const defaults = resolveMcpServeDefaults(config?.mcp?.server);
  if (!defaults.enabled) {
    return { kind: "disabled", defaults };
  }
  if (defaults.transport === "stdio") {
    return {
      kind: "unsupported",
      defaults,
      reason: "MCP stdio transport requires foreground `agenc mcp serve`",
    };
  }

  const server = await startMcpSseServe(defaults, options);
  return { kind: "started", defaults, server };
}

export async function runMcpStdioServe(
  io: McpServerStartIo,
  options: McpServerStartOptions = {},
): Promise<void> {
  const server = createMcpFramework(resolveToolRegistry(options));
  await new Promise<void>((resolve, reject) => {
    const transport = new McpStdioServerTransport({
      input: io.stdin,
      output: io.stdout,
      server,
      onClose: resolve,
      onError: reject,
    });
    transport.start();
  });
}

export async function startMcpSseServe(
  command: McpServerStartCommand,
  options: McpServerStartOptions = {},
): Promise<StartedMcpSseServer> {
  const registry = resolveToolRegistry(options);
  const host = normalizeMcpSseLoopbackHost(command.host);
  const transport = new McpHttpSseServerTransport({
    serverFactory: () => createMcpFramework(registry),
  });
  const server = transport.createNodeServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(command.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : command.port;
  const url = formatMcpSseServeUrl(host, port);
  return {
    server,
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    waitUntilClosed: () =>
      new Promise((resolve) => {
        server.once("close", resolve);
      }),
  };
}

export function formatMcpSseServeUrl(host: string, port: number): string {
  const urlHost = normalizeMcpSseLoopbackHost(host);
  const bracketedHost =
    urlHost.includes(":") && !urlHost.startsWith("[") ? `[${urlHost}]` : urlHost;
  return `http://${bracketedHost}:${port}/mcp`;
}

function readMcpServeHost(host: unknown): string {
  return typeof host === "string" && host.trim().length > 0
    ? host.trim()
    : "127.0.0.1";
}

function readMcpServePort(port: unknown): number {
  const valid =
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= 0 &&
    port <= 65_535;
  return valid ? port : 3334;
}

function normalizeMcpSseLoopbackHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed === "127.0.0.1" || trimmed === "localhost" || trimmed === "::1") {
    return trimmed;
  }
  throw new Error("AgenC MCP SSE transport only binds to loopback hosts");
}

function resolveToolRegistry(options: McpServerStartOptions): ToolRegistry {
  return options.toolRegistry ?? buildToolRegistry({
    workspaceRoot: options.cwd ?? processCwd(),
  });
}

function createMcpFramework(registry: ToolRegistry): McpServerFramework {
  return new McpServerFramework({
    serverInfo: { version: VERSION },
    toolProvider: mcpToolRegistryFromAgenCTools(registry),
  });
}
