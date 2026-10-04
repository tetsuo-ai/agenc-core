/**
 * `agenc mcp` CLI.
 *
 * MS-06 wires the server-side MCP framework into a user-facing command:
 * `agenc mcp serve --transport stdio|sse`.
 */

import type { Readable, Writable } from "node:stream";
import type { HomeContext } from "../config/home.js";
import { ConfigStore } from "../config/store.js";
import { assertCanonicalEnvironmentIngress } from "../config/environment-ingress.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";
import {
  snapshotMcpRequestEnvironment,
  snapshotMcpRequestEnvironmentForAuthority,
} from "../mcp-client/environment.js";
import type { ToolRegistry } from "../tool-registry.js";
import {
  formatMcpSseServeUrl,
  resolveMcpServeDefaults,
  runMcpStdioServe,
  startMcpSseServe,
} from "../mcp/server/start.js";
import { captureSecureStorageIngress } from "../utils/secureStorage/home.js";
import { resolvePluginStorageRootAtIngress } from "../session/runtime-options.js";

export {
  formatMcpSseServeUrl,
  resolveMcpServeDefaults,
  startMcpSseServe,
};

import { formatAgenCMcpCliHelpText, type AgenCMcpCliCommand } from "./mcp-cli-args.js";
export {
  formatAgenCMcpCliHelpText,
  parseAgenCMcpCliArgs,
  parseMcpServeArgs,
  type AgenCMcpCliCommand,
} from "./mcp-cli-args.js";

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
  /** Test/embedding override; CLI ingress otherwise captures process env once. */
  readonly homeContext?: HomeContext;
  /** Existing canonical session authority for embedding/tests. */
  readonly configStore?: ConfigStore;
  /** Immutable environment captured by an embedding ingress. */
  readonly environment?: ProviderEnvironment;
  /** Exact plugin storage root captured by an embedding ingress. */
  readonly pluginStorageRoot?: string;
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
  const ingress = captureSecureStorageIngress(
    options.environment ?? process.env,
  );
  assertCanonicalEnvironmentIngress(ingress.environment);
  const ingressEnvironment = snapshotMcpRequestEnvironment(
    ingress.environment,
  );
  const home =
    options.configStore?.homeContext ?? options.homeContext ?? ingress.home;
  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCMcpCliHelpText()}\n`);
      return 1;
    case "management":
      {
        const configStore = options.configStore ?? new ConfigStore({
          home: home.path,
          cwd: options.cwd ?? process.cwd(),
          env: { ...ingressEnvironment, AGENC_HOME: home.path },
        });
        if (options.configStore === undefined) await configStore.reload();
        const pluginStorageRoot = resolvePluginStorageRootAtIngress(
          {
            ...ingress.environment,
            AGENC_HOME: configStore.homeContext.path,
          },
          options.pluginStorageRoot,
        );
        const environment = snapshotMcpRequestEnvironmentForAuthority(
          ingressEnvironment,
          {
            agencHome: configStore.homeContext.path,
            pluginStorageRoot,
          },
        );
        return runMcpManagementCommand(
          command.argv,
          io,
          configStore,
          environment,
          pluginStorageRoot,
        );
      }
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
  configStore: ConfigStore,
  environment: ProviderEnvironment,
  pluginStorageRoot: string,
): Promise<number> {
  try {
    const action = argv[0];
    const rest = argv.slice(1);
    switch (action) {
      case "capabilities":
      case "inventory":
      case "upsert":
      case "enable":
      case "disable":
      case "authenticate":
      case "logout": {
        const management = await import("../services/mcp/desktop-management.js");
        try {
          const parsed = parseSimpleOptions(rest, { boolean: new Set(["json"]) });
          const context = { authority: configStore, environment, pluginStorageRoot };
          const takesName = ["enable", "disable", "authenticate", "logout"].includes(action);
          assertArity(parsed.positionals, takesName ? 1 : 0, "Invalid MCP management arguments");
          const name = parsed.positionals[0]!;
          let output: unknown;
          if (action === "capabilities") output = management.MCP_DESKTOP_CAPABILITIES;
          else if (action === "inventory") output = await management.mcpDesktopInventory(context);
          else if (action === "upsert") {
            await management.upsertMcpDesktop(context, await management.readMcpDesktopPatch(io.stdin));
            output = { schemaVersion: 1, updated: true };
          } else if (action === "enable" || action === "disable") {
            await management.setMcpDesktopEnabled(context, name, action === "enable");
            output = { schemaVersion: 1, name, enabled: action === "enable" };
          } else if (action === "logout") {
            await management.logoutMcpDesktop(context, name);
            output = { schemaVersion: 1, name, authenticated: false };
          } else {
            const controller = new AbortController();
            const cancel = () => controller.abort();
            process.once("SIGINT", cancel);
            process.once("SIGTERM", cancel);
            try { await management.authenticateMcpDesktop(context, name, controller.signal); }
            finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
            output = { schemaVersion: 1, name, authenticated: true };
          }
          io.stdout.write(`${JSON.stringify(output)}\n`);
          return 0;
        } catch (error) {
          io.stderr.write(`agenc: ${management.safeMcpManagementError(error)}\n`);
          return 1;
        }
      }
      case "add":
        await runMcpAddCommand(rest, io, configStore, environment);
        return 0;
      case "list": {
        assertNoPositionals(rest, "Usage: agenc mcp list");
        const { mcpListHandler } = await import("../cli/handlers/mcp.js");
        await mcpListHandler(configStore, environment, pluginStorageRoot);
        return 0;
      }
      case "get": {
        assertArity(rest, 1, "Usage: agenc mcp get <name>");
        const [name] = rest;
        const { mcpGetHandler } = await import("../cli/handlers/mcp.js");
        await mcpGetHandler(configStore, name!, environment);
        return 0;
      }
      case "remove": {
        const parsed = parseSimpleOptions(rest, {
          value: new Set(["scope", "s"]),
        });
        assertArity(parsed.positionals, 1, "Usage: agenc mcp remove <name>");
        const [name] = parsed.positionals;
        const { mcpRemoveHandler } = await import("../cli/handlers/mcp.js");
        await mcpRemoveHandler(configStore, name!, { scope: parsed.options.scope });
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
          authority: configStore,
          environment,
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
        await mcpAddFromDesktopHandler(configStore, {
          environment,
          pluginStorageRoot,
          scope: parsed.options.scope,
        });
        return 0;
      }
      case "reset-project-choices": {
        assertNoPositionals(rest, "Usage: agenc mcp reset-project-choices");
        const { mcpResetChoicesHandler } = await import("../cli/handlers/mcp.js");
        await mcpResetChoicesHandler(configStore);
        return 0;
      }
      case "approve-project": {
        assertArity(rest, 1, "Usage: agenc mcp approve-project <name>");
        const { mcpApproveProjectHandler } = await import("../cli/handlers/mcp.js");
        await mcpApproveProjectHandler(configStore, rest[0]!);
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
          authority: configStore,
          environment,
          pluginStorageRoot,
          scope: parsed.options.scope,
          configOnly: parsed.flags.has("config-only"),
          json: parsed.flags.has("json"),
        });
        return 0;
      }
      case "xaa": {
        const { runMcpXaaCommand } = await import("../cli/handlers/mcp-xaa.js");
        await runMcpXaaCommand(rest, {
          io,
          env: environment,
          home: configStore.homeContext,
        });
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
  configStore: ConfigStore,
  environment: ProviderEnvironment,
): Promise<void> {
  const parsed = parseSimpleOptions(argv, {
    value: new Set(["scope", "s", "transport", "t", "client-id"]),
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
    xaa: parsed.flags.has("xaa"),
    stdout: io.stdout,
    stderr: io.stderr,
    authority: configStore,
    environment,
  });
}
