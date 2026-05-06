/**
 * `agenc mcp` CLI.
 *
 * MS-06 wires the server-side MCP framework into a user-facing command:
 * `agenc mcp serve --transport stdio|sse`.
 */

import type { Readable, Writable } from "node:stream";
import type { AgenCConfig } from "../config/schema.js";
import type { ToolRegistry } from "../tool-registry.js";
import {
  resolveMcpServeDefaults,
  runMcpStdioServe,
  startMcpSseServe,
} from "../mcp/server/start.js";

export {
  formatMcpSseServeUrl,
  resolveMcpServeDefaults,
  startMcpSseServe,
  type ResolvedMcpServeDefaults,
  type StartedMcpSseServer,
} from "../mcp/server/start.js";

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
    "",
    "Examples:",
    "  agenc mcp serve --transport stdio",
    "  agenc mcp serve --transport sse",
  ].join("\n");
}

export function parseAgenCMcpCliArgs(
  argv: readonly string[],
  config?: AgenCConfig,
): AgenCMcpCliCommand | null {
  if (argv[0] !== "mcp") return null;
  const action = argv[1];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCMcpCliHelpText() };
  }
  if (action !== "serve") {
    return { kind: "error", message: `unknown mcp command: ${action}` };
  }

  return parseMcpServeArgs(argv.slice(2), config);
}

export function parseMcpServeArgs(
  argv: readonly string[],
  config?: AgenCConfig,
): AgenCMcpCliCommand {
  const defaults = resolveMcpServeDefaults(config?.mcp?.server);
  let transport = defaults.transport;
  const host = defaults.host;
  const port = defaults.port;
  const rest = argv;
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
    return {
      kind: "error",
      message: `mcp serve does not accept argument '${arg}'`,
    };
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
