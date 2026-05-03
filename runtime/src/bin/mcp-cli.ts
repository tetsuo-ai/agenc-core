/**
 * `agenc mcp` CLI.
 *
 * MS-06 wires the server-side MCP framework into a user-facing command:
 * `agenc mcp serve --transport stdio|sse`.
 */

import type { Server } from "node:http";
import type { Readable, Writable } from "node:stream";
import { cwd as processCwd } from "node:process";
import { VERSION } from "../index.js";
import {
  McpHttpSseServerTransport,
  McpServerFramework,
  McpStdioServerTransport,
  mcpToolRegistryFromAgenCTools,
} from "../mcp-server/index.js";
import {
  buildToolRegistry,
  type ToolRegistry,
} from "../tool-registry.js";

export type AgenCMcpCliCommand =
  | {
      readonly kind: "serve";
      readonly transport: "stdio" | "sse";
      readonly host: string;
      readonly port: number;
    }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCMcpCliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface StartedMcpSseServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
  waitUntilClosed(): Promise<void>;
}

export interface AgenCMcpCliOptions {
  readonly cwd?: string;
  readonly io?: AgenCMcpCliIo;
  readonly toolRegistry?: ToolRegistry;
  readonly waitForClose?: boolean;
}

export function formatAgenCMcpCliHelpText(): string {
  return [
    "Usage: agenc mcp serve --transport <stdio|sse>",
    "",
    "Commands:",
    "  serve    Expose AgenC tools as an MCP server",
    "",
    "Options:",
    "  --transport <stdio|sse>    Transport to serve (default: stdio)",
  ].join("\n");
}

export function parseAgenCMcpCliArgs(
  argv: readonly string[],
): AgenCMcpCliCommand | null {
  if (argv[0] !== "mcp") return null;
  const action = argv[1];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCMcpCliHelpText() };
  }
  if (action !== "serve") {
    return { kind: "error", message: `unknown mcp command: ${action}` };
  }

  let transport: "stdio" | "sse" = "stdio";
  let host = "127.0.0.1";
  let port = 3334;
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCMcpCliHelpText() };
    }
    if (arg === "--transport") {
      const value = rest[i + 1];
      if (value !== "stdio" && value !== "sse") {
        return {
          kind: "error",
          message: "--transport must be 'stdio' or 'sse'",
        };
      }
      transport = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--transport=")) {
      const value = arg.slice("--transport=".length);
      if (value !== "stdio" && value !== "sse") {
        return {
          kind: "error",
          message: "--transport must be 'stdio' or 'sse'",
        };
      }
      transport = value;
      continue;
    }
    if (
      arg === "--host" ||
      arg.startsWith("--host=") ||
      arg === "--port" ||
      arg.startsWith("--port=")
    ) {
      return {
        kind: "error",
        message: "mcp serve only accepts --transport",
      };
    }
    return { kind: "error", message: `mcp serve does not accept argument '${arg}'` };
  }
  return { kind: "serve", transport, host, port };
}

export async function runAgenCMcpCli(
  command: AgenCMcpCliCommand,
  options: AgenCMcpCliOptions = {},
): Promise<number> {
  const io = options.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCMcpCliHelpText()}\n`);
      return 1;
    case "serve":
      try {
        if (command.transport === "stdio") {
          await runMcpStdioServe(io, options);
          return 0;
        }
        const started = await startMcpSseServe(command, options);
        io.stderr.write(`AgenC MCP server listening on ${started.url}\n`);
        if (options.waitForClose !== false) {
          await started.waitUntilClosed();
        }
        return 0;
      } catch (error) {
        io.stderr.write(
          `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
  }
}

export async function startMcpSseServe(
  command: Extract<AgenCMcpCliCommand, { readonly kind: "serve" }>,
  options: AgenCMcpCliOptions = {},
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

function normalizeMcpSseLoopbackHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed === "127.0.0.1" || trimmed === "localhost" || trimmed === "::1") {
    return trimmed;
  }
  throw new Error("AgenC MCP SSE transport only binds to loopback hosts");
}

async function runMcpStdioServe(
  io: AgenCMcpCliIo,
  options: AgenCMcpCliOptions,
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

function resolveToolRegistry(options: AgenCMcpCliOptions): ToolRegistry {
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
