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
  formatMcpSseServeUrl,
  resolveMcpServeDefaults,
  runMcpStdioServe,
  startMcpSseServe,
} from "../mcp/server/start.js";

export {
  formatMcpSseServeUrl,
  resolveMcpServeDefaults,
  startMcpSseServe,
};

export type AgenCMcpCliCommand =
  | {
      readonly kind: "serve";
      readonly transport: "stdio" | "sse";
      readonly host: string;
      readonly port: number;
    }
  | { readonly kind: "management"; readonly argv: readonly string[] }
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

const MCP_MANAGEMENT_COMMANDS = new Set([
  "add",
  "list",
  "get",
  "remove",
  "add-json",
  "add-from-agenc-desktop",
  "reset-project-choices",
  "doctor",
  "xaa",
]);

export function formatAgenCMcpCliHelpText(): string {
  return [
    "Usage: agenc mcp <command> [options]",
    "",
    "Commands:",
    "  serve                    Expose workspace-scoped read-only tools over MCP",
    "  add                      Add an MCP server",
    "  list                     List configured MCP servers",
    "  get                      Show one MCP server",
    "  remove                   Remove an MCP server",
    "  add-json                 Add an MCP server from JSON",
    "  add-from-agenc-desktop   Import servers from AgenC Desktop config",
    "  reset-project-choices    Reset project MCP approval choices",
    "  doctor                   Diagnose MCP configuration",
    "  xaa                      Manage XAA IdP authentication",
    "",
    "Options:",
    "  serve --transport <stdio|sse>       Transport for serve",
    "  add -t, --transport <stdio|sse|http> Transport for add",
    "  -s, --scope <scope>        Config scope for add/remove/import commands (default: user for add/add-json)",
    "  -e, --env <KEY=value>      Environment variable for stdio add",
    "  -H, --header <K: V>        Header for HTTP/SSE add",
    "  --client-secret           Prompt for remote MCP OAuth client secret",
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
    if (MCP_MANAGEMENT_COMMANDS.has(action)) {
      return { kind: "management", argv: argv.slice(1) };
    }
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
    case "management":
      return runMcpManagementCommand(command.argv, io);
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

async function runMcpManagementCommand(
  argv: readonly string[],
  io: AgenCMcpCliIo,
): Promise<number> {
  try {
    const action = argv[0];
    const rest = argv.slice(1);
    switch (action) {
      case "add":
        await runMcpAddCommand(rest, io);
        return 0;
      case "list": {
        assertNoPositionals(rest, "Usage: agenc mcp list");
        const { mcpListHandler } = await import("../cli/handlers/mcp.js");
        await mcpListHandler();
        return 0;
      }
      case "get": {
        assertArity(rest, 1, "Usage: agenc mcp get <name>");
        const [name] = rest;
        const { mcpGetHandler } = await import("../cli/handlers/mcp.js");
        await mcpGetHandler(name!);
        return 0;
      }
      case "remove": {
        const parsed = parseSimpleOptions(rest, {
          value: new Set(["scope", "s"]),
        });
        assertArity(parsed.positionals, 1, "Usage: agenc mcp remove <name>");
        const [name] = parsed.positionals;
        const { mcpRemoveHandler } = await import("../cli/handlers/mcp.js");
        await mcpRemoveHandler(name!, { scope: parsed.options.scope });
        return 0;
      }
      case "add-json": {
        const parsed = parseSimpleOptions(rest, {
          value: new Set(["scope", "s"]),
          boolean: new Set(["client-secret"]),
        });
        assertArity(parsed.positionals, 2, "Usage: agenc mcp add-json <name> <json>");
        const [name, json] = parsed.positionals;
        const { mcpAddJsonHandler } = await import("../cli/handlers/mcp.js");
        await mcpAddJsonHandler(name!, json!, {
          scope: parsed.options.scope,
          ...(parsed.flags.has("client-secret") ? { clientSecret: true } : {}),
        });
        return 0;
      }
      case "add-from-agenc-desktop": {
        const parsed = parseSimpleOptions(rest, {
          value: new Set(["scope", "s"]),
        });
        assertNoPositionals(parsed.positionals, "Usage: agenc mcp add-from-agenc-desktop");
        const { mcpAddFromDesktopHandler } = await import("../cli/handlers/mcp.js");
        await mcpAddFromDesktopHandler({ scope: parsed.options.scope });
        return 0;
      }
      case "reset-project-choices": {
        assertNoPositionals(rest, "Usage: agenc mcp reset-project-choices");
        const { mcpResetChoicesHandler } = await import("../cli/handlers/mcp.js");
        await mcpResetChoicesHandler();
        return 0;
      }
      case "doctor": {
        const parsed = parseSimpleOptions(rest, {
          value: new Set(["scope", "s"]),
          boolean: new Set(["config-only", "json"]),
        });
        if (parsed.positionals.length > 1) {
          throw new Error("Usage: agenc mcp doctor [name]");
        }
        const { mcpDoctorHandler } = await import("../cli/handlers/mcp.js");
        await mcpDoctorHandler(parsed.positionals[0], {
          scope: parsed.options.scope,
          configOnly: parsed.flags.has("config-only"),
          json: parsed.flags.has("json"),
        });
        return 0;
      }
      case "xaa": {
        const { runMcpXaaCommand } = await import("../cli/handlers/mcp-xaa.js");
        await runMcpXaaCommand(rest, { io, env: process.env });
        return 0;
      }
    }
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

function assertArity(
  values: readonly string[],
  expected: number,
  usage: string,
): void {
  if (values.length !== expected) throw new Error(usage);
}

function assertNoPositionals(values: readonly string[], usage: string): void {
  assertArity(values, 0, usage);
}

interface ParsedMcpOptions {
  readonly options: Record<string, string>;
  readonly repeated: Record<string, string[]>;
  readonly flags: Set<string>;
  readonly positionals: string[];
}

function normalizeMcpOptionName(name: string): string {
  return name === "s" ? "scope" : name === "t" ? "transport" : name === "e"
    ? "env"
    : name === "H"
      ? "header"
      : name;
}

function parseSimpleOptions(
  argv: readonly string[],
  spec: {
    readonly value?: ReadonlySet<string>;
    readonly repeated?: ReadonlySet<string>;
    readonly boolean?: ReadonlySet<string>;
  },
): ParsedMcpOptions {
  const valueOptions = spec.value ?? new Set<string>();
  const repeatedOptions = spec.repeated ?? new Set<string>();
  const booleanOptions = spec.boolean ?? new Set<string>();
  const options: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  let parsingOptions = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (parsingOptions && arg === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg.startsWith("-")) {
      const trimmed = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
      const eq = trimmed.indexOf("=");
      const rawName = eq === -1 ? trimmed : trimmed.slice(0, eq);
      const name = normalizeMcpOptionName(rawName);
      const inlineValue = eq === -1 ? undefined : trimmed.slice(eq + 1);
      if (booleanOptions.has(name)) {
        if (inlineValue !== undefined) {
          throw new Error(`Option --${name} does not take a value`);
        }
        flags.add(name);
        continue;
      }
      if (valueOptions.has(rawName) || valueOptions.has(name) || repeatedOptions.has(rawName) || repeatedOptions.has(name)) {
        const value = inlineValue ?? argv[++i];
        if (value === undefined) throw new Error(`Missing value for --${name}`);
        if (repeatedOptions.has(rawName) || repeatedOptions.has(name)) {
          repeated[name] = [...(repeated[name] ?? []), value];
        } else {
          options[name] = value;
        }
        continue;
      }
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  return { options, repeated, flags, positionals };
}

async function runMcpAddCommand(
  argv: readonly string[],
  io: AgenCMcpCliIo,
): Promise<void> {
  const parsed = parseSimpleOptions(argv, {
    value: new Set(["scope", "s", "transport", "t", "client-id", "callback-port"]),
    repeated: new Set(["env", "e", "header", "H"]),
    boolean: new Set(["client-secret", "xaa"]),
  });
  const [name, commandOrUrl, ...args] = parsed.positionals;
  if (!name || !commandOrUrl) {
    throw new Error("Usage: agenc mcp add <name> <command-or-url> [args...]");
  }

  const { runMcpAddAction } = await import("../cli/handlers/mcp-add-action.js");
  await runMcpAddAction(name, commandOrUrl, args, {
    scope: parsed.options.scope,
    transport: parsed.options.transport,
    env: parsed.repeated.env,
    header: parsed.repeated.header,
    clientId: parsed.options["client-id"],
    clientSecret: parsed.flags.has("client-secret"),
    callbackPort: parsed.options["callback-port"],
    xaa: parsed.flags.has("xaa"),
    stdout: io.stdout,
    stderr: io.stderr,
  });
}
