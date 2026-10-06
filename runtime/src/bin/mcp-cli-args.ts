import type { AgenCConfig } from "../config/schema.js";
import { resolveMcpServeDefaults } from "../mcp/server/defaults.js";

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

const MCP_MANAGEMENT_COMMANDS = new Set([
  "capabilities",
  "inventory",
  "upsert",
  "enable",
  "disable",
  "authenticate",
  "logout",
  "add",
  "list",
  "get",
  "remove",
  "add-json",
  "add-from-agenc-desktop",
  "approve-project",
  "reset-project-choices",
  "doctor",
  "xaa",
]);

export function formatAgenCMcpCliHelpText(): string {
  return [
    "Usage: agenc mcp <command> [options]",
    "",
    "Commands:",
    "  capabilities --json      Report supported MCP management contracts",
    "  inventory --json         Redacted MCP configuration and authentication state",
    "  upsert --json            Apply a revision-checked user MCP JSON patch from stdin",
    "  enable <name>            Enable one exact MCP definition",
    "  disable <name>           Disable one exact MCP definition",
    "  authenticate <name>      Connect remote OAuth using the system browser",
    "  logout <name>            Forget this MCP server's local OAuth credentials",
    "  serve                    Expose workspace-scoped prompts/resources over MCP",
    "  add                      Add an MCP server",
    "  list                     List configured MCP servers",
    "  get                      Show one MCP server",
    "  remove                   Remove an MCP server",
    "  add-json                 Add an MCP server from JSON",
    "  add-from-agenc-desktop   Import servers from AgenC Desktop config",
    "  approve-project          Approve the exact current project MCP definition",
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
