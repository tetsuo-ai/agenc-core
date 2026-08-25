import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PluginComponentKind, PluginManifestInterface } from "../manifest-schema.js";
import type { ValidationResult } from "../validation.js";
import {
  disableAllPluginsOp,
  formatPluginList,
  installPluginOp,
  listInstalledPlugins,
  setPluginEnabledOp,
  uninstallPluginOp,
  updatePluginOp,
  validatePluginPath,
  type InstallPluginInput,
  type InstallPluginResult,
  type PluginCliIo,
  type PluginScope,
} from "./pluginOperations.js";
import {
  addMarketplaceOp,
  findInstallableMarketplacePlugin,
  loadMarketplace,
  readMarketplaceIndex,
  type MarketplacePluginPolicy,
  type MarketplacePluginSource,
  type MarketplaceOperationOptions,
  removeMarketplaceOp,
  upgradeMarketplaceOp,
} from "../marketplace/marketplace.js";

export type AgenCPluginCliCommand =
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "validate"; readonly path: string; readonly marketplace: boolean; readonly json: boolean }
  | { readonly kind: "install"; readonly source: string; readonly scope: PluginScope; readonly name?: string; readonly force: boolean }
  | { readonly kind: "uninstall"; readonly pluginId: string; readonly scope: PluginScope; readonly keepData: boolean }
  | { readonly kind: "update"; readonly pluginId: string; readonly scope: PluginScope; readonly source?: string }
  | { readonly kind: "enable"; readonly pluginId: string; readonly path?: string }
  | { readonly kind: "disable"; readonly pluginId: string }
  | { readonly kind: "disable-all" }
  | { readonly kind: "marketplace-list"; readonly json: boolean }
  | { readonly kind: "marketplace-catalog"; readonly json: boolean; readonly product?: string }
  | { readonly kind: "marketplace-install"; readonly pluginId: string; readonly scope: PluginScope; readonly force: boolean; readonly json: boolean; readonly product?: string }
  | { readonly kind: "marketplace-add"; readonly source: string; readonly name?: string; readonly ref?: string; readonly sparse?: string; readonly force: boolean }
  | { readonly kind: "marketplace-remove"; readonly name: string }
  | { readonly kind: "marketplace-upgrade"; readonly name?: string }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCPluginCliOptions extends MarketplaceOperationOptions {
  readonly io?: PluginCliIo;
  /** Trusted publisher keyring used by the runtime's Ed25519 verifier. */
  readonly publishersPath?: string;
  /** Test/embedding seam; production always uses installPluginOp. */
  readonly installPlugin?: (input: InstallPluginInput) => Promise<InstallPluginResult>;
}

export const AGENC_PLUGIN_MARKETPLACE_CATALOG_SCHEMA_VERSION = 1 as const;

export interface AgenCPluginMarketplaceCatalogPlugin {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly source: MarketplacePluginSource;
  readonly policy: MarketplacePluginPolicy;
  readonly version?: string;
  readonly description?: string;
  readonly components: readonly PluginComponentKind[];
  readonly interface?: PluginManifestInterface;
}

export interface AgenCPluginMarketplaceCatalog {
  readonly schemaVersion: typeof AGENC_PLUGIN_MARKETPLACE_CATALOG_SCHEMA_VERSION;
  readonly kind: "agenc.plugin.marketplace.catalog";
  readonly product?: string;
  readonly marketplaces: readonly {
    readonly name: string;
    readonly displayName?: string;
    readonly sourceType: string;
    readonly source: string;
    readonly plugins: readonly AgenCPluginMarketplaceCatalogPlugin[];
  }[];
  readonly errors: readonly {
    readonly marketplace: string;
    readonly path: string;
    readonly message: string;
  }[];
}

export function formatAgenCPluginCliHelpText(): string {
  return [
    "Usage: agenc plugin <command> [options]",
    "",
    "Commands:",
    "  list [--json]                                  List installed plugins",
    "  validate <path> [--marketplace] [--json]       Validate a plugin or marketplace manifest",
    "  install <path> [--scope <user|project|local>]  Install a local plugin directory",
    "  uninstall <name> [--scope <user|project|local>] Remove an installed plugin",
    "  update <name> [--source <path>]                 Refresh an installed plugin from its source",
    "  enable <name> [--path <path>]                  Enable a plugin in user config",
    "  disable <name>                                 Disable a plugin in user config",
    "  disable-all                                    Disable every currently enabled plugin",
    "  marketplace list [--json]                      List configured marketplaces",
    "  marketplace catalog [--product <id>] [--json]  List installable plugins with canonical IDs",
    "  marketplace install <plugin@marketplace>       Install a catalog plugin",
    "                       [--product <id>] [--json]",
    "  marketplace add <path|git|url|github> [--name <name>]",
    "                                                   Add local, git, URL, or GitHub marketplace",
    "  marketplace remove <name>                      Remove a marketplace",
    "  marketplace upgrade [name]                     Refresh git or local marketplaces",
    "",
    "Install options:",
    "  --name <name>     Override the installed plugin or marketplace name",
    "  --force           Replace an existing install",
    "  --keep-data       Keep plugin data during uninstall",
    "",
    "Marketplace options:",
    "  --ref <ref>       Git branch, tag, or revision to checkout",
    "  --sparse <path>   Git sparse-checkout path containing marketplace.json",
    "",
    "Examples:",
    "  agenc plugin list",
    "  agenc plugin install ./my-plugin --scope project",
    "  agenc plugin enable my-plugin",
    "  agenc plugin marketplace add ./marketplace --name team",
    "  agenc plugin marketplace catalog --json",
    "  agenc plugin marketplace install toolbox@team --json",
  ].join("\n");
}

export function parseAgenCPluginCliArgs(
  argv: readonly string[],
): AgenCPluginCliCommand | null {
  if (argv[0] !== "plugin") return null;
  const action = argv[1];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCPluginCliHelpText() };
  }
  switch (action) {
    case "list":
      return parseList(argv.slice(2));
    case "validate":
      return parseValidate(argv.slice(2));
    case "install":
      return parseInstall(argv.slice(2));
    case "uninstall":
      return parseUninstall(argv.slice(2));
    case "update":
      return parseUpdate(argv.slice(2));
    case "enable":
      return parseEnable(argv.slice(2));
    case "disable":
      return parseDisable(argv.slice(2));
    case "disable-all":
      return parseDisableAll(argv.slice(2));
    case "marketplace":
      return parseMarketplace(argv.slice(2));
    default:
      return { kind: "error", message: `unknown plugin command: ${action}` };
  }
}

/**
 * Names the plugin components a non-user-scope (repository-controlled)
 * install will silently strip: hooks and MCP servers. Checks both the
 * conventional component files and the manifest declarations.
 */
async function detectProvenanceStrippedComponents(
  pluginRoot: string,
): Promise<string[]> {
  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  };
  let manifest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(pluginRoot, ".agenc-plugin", "plugin.json"), "utf8"),
    );
    if (parsed !== null && typeof parsed === "object") {
      manifest = parsed as Record<string, unknown>;
    }
  } catch {
    // No readable manifest: fall back to the conventional file checks.
  }
  const stripped: string[] = [];
  if (
    (await exists(join(pluginRoot, "hooks", "hooks.json"))) ||
    manifest.hooks !== undefined
  ) {
    stripped.push("hooks");
  }
  if (
    (await exists(join(pluginRoot, ".mcp.json"))) ||
    manifest.mcpServers !== undefined
  ) {
    stripped.push("MCP servers");
  }
  return stripped;
}

export async function runAgenCPluginCli(
  command: AgenCPluginCliCommand,
  options: AgenCPluginCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  try {
    switch (command.kind) {
      case "help":
        io.stdout.write(`${command.text}\n`);
        return 0;
      case "error":
        io.stderr.write(`agenc: ${command.message}\n`);
        io.stderr.write(`${formatAgenCPluginCliHelpText()}\n`);
        return 1;
      case "list": {
        const result = await listInstalledPlugins(options);
        io.stdout.write(command.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${formatPluginList(result)}\n`);
        return 0;
      }
      case "validate": {
        const result = await validatePluginPath(command.path, {
          marketplace: command.marketplace,
        });
        io.stdout.write(command.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${formatValidationResult(result)}\n`);
        return result.success ? 0 : 1;
      }
      case "install": {
        const result = await installPluginOp({
          ...options,
          source: command.source,
          scope: command.scope,
          ...(command.name !== undefined ? { name: command.name } : {}),
          force: command.force,
        });
        io.stdout.write(
          `Installed plugin ${result.plugin.name} to ${result.scope} scope: ${result.destination}\n`,
        );
        // Workspace-resident plugin content is repository-controlled, which
        // strips hooks and MCP servers at load time (plugins/loader.ts). Say
        // so at install time instead of letting those components vanish
        // silently.
        if (result.scope !== "user") {
          const stripped = await detectProvenanceStrippedComponents(
            result.destination,
          );
          if (stripped.length > 0) {
            io.stderr.write(
              `Warning: this plugin ships ${stripped.join(" and ")}, which do NOT load from ` +
                `${result.scope} scope (workspace content is repository-controlled). ` +
                `Install with --scope user to enable them.\n`,
            );
          }
        }
        return 0;
      }
      case "uninstall": {
        const result = await uninstallPluginOp({
          ...options,
          pluginId: command.pluginId,
          scope: command.scope,
          keepData: command.keepData,
        });
        io.stdout.write(
          `Uninstalled plugin ${result.pluginId}: ${result.removedRoots.length} path(s) removed\n`,
        );
        return 0;
      }
      case "update": {
        const result = await updatePluginOp({
          ...options,
          pluginId: command.pluginId,
          scope: command.scope,
          ...(command.source !== undefined ? { source: command.source } : {}),
        });
        io.stdout.write(
          `Updated plugin ${result.plugin.name} from ${result.source}: ${result.destination}\n`,
        );
        return 0;
      }
      case "enable": {
        const result = await setPluginEnabledOp({
          ...options,
          pluginId: command.pluginId,
          enabled: true,
          ...(command.path !== undefined ? { path: command.path } : {}),
        });
        io.stdout.write(`Enabled plugin ${result.pluginId} in ${result.configPath}\n`);
        return 0;
      }
      case "disable": {
        const result = await setPluginEnabledOp({
          ...options,
          pluginId: command.pluginId,
          enabled: false,
        });
        io.stdout.write(`Disabled plugin ${result.pluginId} in ${result.configPath}\n`);
        return 0;
      }
      case "disable-all": {
        const result = await disableAllPluginsOp(options);
        io.stdout.write(`Disabled ${result.disabled.length} plugin(s) in ${result.configPath}\n`);
        return 0;
      }
      case "marketplace-list": {
        const index = await readMarketplaceIndex(options);
        const marketplaces = Object.values(index.marketplaces)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (command.json) {
          io.stdout.write(`${JSON.stringify({ marketplaces }, null, 2)}\n`);
        } else if (marketplaces.length === 0) {
          io.stdout.write("No AgenC plugin marketplaces configured.\n");
        } else {
          io.stdout.write([
            "AgenC plugin marketplaces:",
            ...marketplaces.map((marketplace) =>
              `- ${marketplace.name} (${marketplace.sourceType}) ${marketplace.source}`),
          ].join("\n") + "\n");
        }
        return 0;
      }
      case "marketplace-catalog": {
        const catalog = await buildMarketplaceCatalog(options, command.product);
        if (command.json) {
          io.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
        } else if (catalog.marketplaces.length === 0) {
          io.stdout.write("No AgenC plugin marketplace catalog entries available.\n");
        } else {
          const lines = ["AgenC plugin marketplace catalog:"];
          for (const marketplace of catalog.marketplaces) {
            lines.push(`\n${marketplace.displayName ?? marketplace.name}:`);
            for (const plugin of marketplace.plugins) {
              lines.push(`- ${plugin.id} (${plugin.policy.installation})`);
            }
          }
          for (const error of catalog.errors) {
            lines.push(`! ${error.marketplace}: ${error.message}`);
          }
          io.stdout.write(`${lines.join("\n")}\n`);
        }
        return catalog.errors.length > 0 && catalog.marketplaces.length === 0 ? 1 : 0;
      }
      case "marketplace-install": {
        const { pluginName, marketplaceName } = parseCanonicalMarketplacePluginId(
          command.pluginId,
        );
        const index = await readMarketplaceIndex(options);
        const record = Object.values(index.marketplaces).find(
          (entry) => entry.name.toLowerCase() === marketplaceName.toLowerCase(),
        );
        if (record === undefined) {
          throw new Error(`marketplace is not configured: ${marketplaceName}`);
        }
        const resolved = await findInstallableMarketplacePlugin(
          record.manifestPath,
          pluginName,
          command.product,
          record.name,
        );
        const source = resolved.source.type === "local"
          ? resolved.source.path
          : resolved.source.url;
        const install = options.installPlugin ?? installPluginOp;
        const result = await install({
          ...options,
          source,
          scope: command.scope,
          name: resolved.pluginName,
          pluginId: resolved.pluginId,
          force: command.force,
          ...(record.sourceType !== "local" ? { requireSignature: true } : {}),
          ...(resolved.source.type === "git" && resolved.source.path !== undefined
            ? { gitSubdir: resolved.source.path }
            : {}),
          ...(resolved.source.type === "git" && resolved.source.ref !== undefined
            ? { gitRef: resolved.source.ref }
            : {}),
          ...(resolved.source.type === "git" && resolved.source.sha !== undefined
            ? { gitSha: resolved.source.sha }
            : {}),
          ...(options.runProcess !== undefined
            ? { runResolutionProcess: options.runProcess }
            : {}),
        });
        if (command.json) {
          io.stdout.write(`${JSON.stringify({
            schemaVersion: 1,
            kind: "agenc.plugin.marketplace.install",
            pluginId: resolved.pluginId,
            marketplace: resolved.marketplaceName,
            ...(command.product !== undefined ? { product: command.product } : {}),
            source: resolved.source,
            plugin: result.plugin,
            destination: result.destination,
            scope: result.scope,
            resolutionKind: result.resolutionKind,
            signatureVerified: result.signatureVerified,
          }, null, 2)}\n`);
        } else {
          io.stdout.write(
            `Installed plugin ${resolved.pluginId} to ${result.scope} scope: ${result.destination}\n`,
          );
        }
        return 0;
      }
      case "marketplace-add": {
        const result = await addMarketplaceOp({
          ...options,
          source: command.source,
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(command.ref !== undefined ? { ref: command.ref } : {}),
          ...(command.sparse !== undefined ? { sparse: command.sparse } : {}),
          force: command.force,
        });
        io.stdout.write(
          `${result.replaced ? "Updated" : "Added"} marketplace ${result.marketplace.name}: ${result.marketplace.installedPath}\n`,
        );
        return 0;
      }
      case "marketplace-remove": {
        const result = await removeMarketplaceOp({
          ...options,
          name: command.name,
        });
        io.stdout.write(`Removed marketplace ${result.marketplace.name}\n`);
        return 0;
      }
      case "marketplace-upgrade": {
        const result = await upgradeMarketplaceOp({
          ...options,
          ...(command.name !== undefined ? { name: command.name } : {}),
        });
        io.stdout.write(`Upgraded ${result.upgraded.length} marketplace(s)\n`);
        for (const skipped of result.skipped) {
          io.stdout.write(`Skipped marketplace ${skipped.marketplace.name}: ${skipped.reason}\n`);
        }
        return 0;
      }
    }
  } catch (error) {
    if (
      (command.kind === "marketplace-catalog" || command.kind === "marketplace-install") &&
      command.json
    ) {
      io.stdout.write(`${JSON.stringify({
        schemaVersion: AGENC_PLUGIN_MARKETPLACE_CATALOG_SCHEMA_VERSION,
        kind: command.kind === "marketplace-catalog"
          ? "agenc.plugin.marketplace.catalog.error"
          : "agenc.plugin.marketplace.install.error",
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      }, null, 2)}\n`);
      return 1;
    }
    io.stderr.write(`agenc: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function buildMarketplaceCatalog(
  options: MarketplaceOperationOptions,
  product?: string,
): Promise<AgenCPluginMarketplaceCatalog> {
  const index = await readMarketplaceIndex(options);
  const marketplaces: AgenCPluginMarketplaceCatalog["marketplaces"][number][] = [];
  const errors: AgenCPluginMarketplaceCatalog["errors"][number][] = [];
  for (const record of Object.values(index.marketplaces).sort((left, right) =>
    left.name.localeCompare(right.name))) {
    try {
      const marketplace = await loadMarketplace(record.manifestPath, record.name);
      marketplaces.push({
        name: marketplace.name,
        ...(marketplace.interface?.displayName !== undefined
          ? { displayName: marketplace.interface.displayName }
          : {}),
        sourceType: record.sourceType,
        source: record.source,
        plugins: marketplace.plugins
          .filter((plugin) =>
            plugin.policy.installation !== "NOT_AVAILABLE" &&
            marketplacePluginSupportsProduct(plugin.policy, product))
          .map((plugin) => ({
            id: `${plugin.name}@${marketplace.name}`,
            name: plugin.name,
            marketplace: marketplace.name,
            source: plugin.source,
            policy: plugin.policy,
            ...(plugin.version !== undefined ? { version: plugin.version } : {}),
            ...(plugin.description !== undefined ? { description: plugin.description } : {}),
            components: plugin.components,
            ...(plugin.interface !== undefined ? { interface: plugin.interface } : {}),
          })),
      });
    } catch (error) {
      errors.push({
        marketplace: record.name,
        path: record.manifestPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    schemaVersion: AGENC_PLUGIN_MARKETPLACE_CATALOG_SCHEMA_VERSION,
    kind: "agenc.plugin.marketplace.catalog",
    ...(product !== undefined ? { product } : {}),
    marketplaces,
    errors,
  };
}

function marketplacePluginSupportsProduct(
  policy: MarketplacePluginPolicy,
  product: string | undefined,
): boolean {
  if (policy.products === undefined) return true;
  return policy.products.length > 0 &&
    product !== undefined &&
    policy.products.includes(product);
}

function parseCanonicalMarketplacePluginId(pluginId: string): {
  readonly pluginName: string;
  readonly marketplaceName: string;
} {
  const separator = pluginId.lastIndexOf("@");
  const pluginName = separator > 0 ? pluginId.slice(0, separator) : "";
  const marketplaceName = separator > 0 ? pluginId.slice(separator + 1) : "";
  if (pluginName.length === 0 || marketplaceName.length === 0) {
    throw new Error(
      "marketplace plugin id must use the canonical name@marketplace form",
    );
  }
  return { pluginName, marketplaceName };
}

function parseList(args: readonly string[]): AgenCPluginCliCommand {
  let json = false;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCPluginCliHelpText() };
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    return { kind: "error", message: `plugin list does not accept argument '${arg}'` };
  }
  return { kind: "list", json };
}

function parseValidate(args: readonly string[]): AgenCPluginCliCommand {
  let json = false;
  let marketplace = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCPluginCliHelpText() };
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--marketplace") {
      marketplace = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return { kind: "error", message: `unknown plugin validate option: ${arg}` };
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    return { kind: "error", message: "plugin validate requires exactly one path" };
  }
  return { kind: "validate", path: positional[0]!, marketplace, json };
}

function parseInstall(args: readonly string[]): AgenCPluginCliCommand {
  let scope: PluginScope = "user";
  let name: string | undefined;
  let force = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "help", text: formatAgenCPluginCliHelpText() };
    if (arg === "--force") {
      force = true;
      continue;
    }
      const parsed = parseValueOption(args, i, arg, ["--scope", "--name"]);
      if (parsed !== null) {
        i = parsed.nextIndex;
        if (parsed.value.length === 0) {
          return { kind: "error", message: `${parsed.name} requires a value` };
        }
        if (parsed.name === "--scope") {
        const parsedScope = parseScope(parsed.value);
        if (parsedScope === null) return { kind: "error", message: "--scope must be user, project, or local" };
        scope = parsedScope;
      } else {
        name = parsed.value;
      }
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", message: `unknown plugin install option: ${arg}` };
    positional.push(arg);
  }
  if (positional.length !== 1) {
    return { kind: "error", message: "plugin install requires exactly one source path" };
  }
  return {
    kind: "install",
    source: positional[0]!,
    scope,
    ...(name !== undefined ? { name } : {}),
    force,
  };
}

function parseUninstall(args: readonly string[]): AgenCPluginCliCommand {
  let scope: PluginScope = "user";
  let keepData = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "help", text: formatAgenCPluginCliHelpText() };
    if (arg === "--keep-data") {
      keepData = true;
      continue;
    }
    const parsed = parseValueOption(args, i, arg, ["--scope"]);
    if (parsed !== null) {
      i = parsed.nextIndex;
      if (parsed.value.length === 0) {
        return { kind: "error", message: `${parsed.name} requires a value` };
      }
      const parsedScope = parseScope(parsed.value);
      if (parsedScope === null) return { kind: "error", message: "--scope must be user, project, or local" };
      scope = parsedScope;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", message: `unknown plugin uninstall option: ${arg}` };
    positional.push(arg);
  }
  if (positional.length !== 1) {
    return { kind: "error", message: "plugin uninstall requires exactly one plugin name" };
  }
  return { kind: "uninstall", pluginId: positional[0]!, scope, keepData };
}

function parseUpdate(args: readonly string[]): AgenCPluginCliCommand {
  let scope: PluginScope = "user";
  let source: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "help", text: formatAgenCPluginCliHelpText() };
    const parsed = parseValueOption(args, i, arg, ["--scope", "--source"]);
    if (parsed !== null) {
      i = parsed.nextIndex;
      if (parsed.value.length === 0) {
        return { kind: "error", message: `${parsed.name} requires a value` };
      }
      if (parsed.name === "--scope") {
        const parsedScope = parseScope(parsed.value);
        if (parsedScope === null) return { kind: "error", message: "--scope must be user, project, or local" };
        scope = parsedScope;
      } else {
        source = parsed.value;
      }
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", message: `unknown plugin update option: ${arg}` };
    positional.push(arg);
  }
  if (positional.length !== 1) {
    return { kind: "error", message: "plugin update requires exactly one plugin name" };
  }
  return {
    kind: "update",
    pluginId: positional[0]!,
    scope,
    ...(source !== undefined ? { source } : {}),
  };
}

function parseEnable(args: readonly string[]): AgenCPluginCliCommand {
  let path: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "help", text: formatAgenCPluginCliHelpText() };
    const parsed = parseValueOption(args, i, arg, ["--path"]);
    if (parsed !== null) {
      i = parsed.nextIndex;
      if (parsed.value.length === 0) {
        return { kind: "error", message: `${parsed.name} requires a value` };
      }
      path = parsed.value;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", message: `unknown plugin enable option: ${arg}` };
    positional.push(arg);
  }
  if (positional.length !== 1) {
    return { kind: "error", message: "plugin enable requires exactly one plugin name" };
  }
  return {
    kind: "enable",
    pluginId: positional[0]!,
    ...(path !== undefined ? { path } : {}),
  };
}

function parseDisable(args: readonly string[]): AgenCPluginCliCommand {
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
    return args[0] === "--help" || args[0] === "-h"
      ? { kind: "help", text: formatAgenCPluginCliHelpText() }
      : { kind: "error", message: "plugin disable requires exactly one plugin name" };
  }
  return { kind: "disable", pluginId: args[0]! };
}

function parseDisableAll(args: readonly string[]): AgenCPluginCliCommand {
  if (args.length === 0) return { kind: "disable-all" };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { kind: "help", text: formatAgenCPluginCliHelpText() };
  }
  return { kind: "error", message: "plugin disable-all accepts no arguments" };
}

function parseMarketplace(args: readonly string[]): AgenCPluginCliCommand {
  const action = args[0];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCPluginCliHelpText() };
  }
  switch (action) {
    case "list":
      return parseMarketplaceList(args.slice(1));
    case "catalog":
      return parseMarketplaceCatalog(args.slice(1));
    case "install":
      return parseMarketplaceInstall(args.slice(1));
    case "add":
      return parseMarketplaceAdd(args.slice(1));
    case "remove":
      return parseMarketplaceRemove(args.slice(1));
    case "upgrade":
      return parseMarketplaceUpgrade(args.slice(1));
    default:
      return { kind: "error", message: `unknown plugin marketplace command: ${action}` };
  }
}

function parseMarketplaceList(args: readonly string[]): AgenCPluginCliCommand {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { kind: "help", text: formatAgenCPluginCliHelpText() };
    return { kind: "error", message: `plugin marketplace list does not accept argument '${arg}'` };
  }
  return { kind: "marketplace-list", json };
}

function parseMarketplaceCatalog(args: readonly string[]): AgenCPluginCliCommand {
  let json = false;
  let product: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCPluginCliHelpText() };
    }
    const parsed = parseValueOption(args, index, arg, ["--product"]);
    if (parsed !== null) {
      index = parsed.nextIndex;
      if (parsed.value.length === 0) {
        return { kind: "error", message: "--product requires a value" };
      }
      product = parsed.value;
      continue;
    }
    return {
      kind: "error",
      message: `plugin marketplace catalog does not accept argument '${arg}'`,
    };
  }
  return {
    kind: "marketplace-catalog",
    json,
    ...(product !== undefined ? { product } : {}),
  };
}

function parseMarketplaceInstall(args: readonly string[]): AgenCPluginCliCommand {
  let scope: PluginScope = "user";
  let force = false;
  let json = false;
  let product: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCPluginCliHelpText() };
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    const parsed = parseValueOption(args, index, arg, ["--scope", "--product"]);
    if (parsed !== null) {
      index = parsed.nextIndex;
      if (parsed.value.length === 0) {
        return { kind: "error", message: `${parsed.name} requires a value` };
      }
      if (parsed.name === "--scope") {
        const parsedScope = parseScope(parsed.value);
        if (parsedScope === null) {
          return {
            kind: "error",
            message: "--scope must be user, project, or local",
          };
        }
        scope = parsedScope;
      } else {
        product = parsed.value;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return {
        kind: "error",
        message: `unknown marketplace install option: ${arg}`,
      };
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    return {
      kind: "error",
      message: "plugin marketplace install requires exactly one name@marketplace id",
    };
  }
  try {
    parseCanonicalMarketplacePluginId(positional[0]!);
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    kind: "marketplace-install",
    pluginId: positional[0]!,
    scope,
    force,
    json,
    ...(product !== undefined ? { product } : {}),
  };
}

function parseMarketplaceAdd(args: readonly string[]): AgenCPluginCliCommand {
  let name: string | undefined;
  let ref: string | undefined;
  let sparse: string | undefined;
  let force = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "help", text: formatAgenCPluginCliHelpText() };
    if (arg === "--force") {
      force = true;
      continue;
    }
    const parsed = parseValueOption(args, i, arg, ["--name", "--ref", "--sparse"]);
    if (parsed !== null) {
      i = parsed.nextIndex;
      if (parsed.value.length === 0) {
        return { kind: "error", message: `${parsed.name} requires a value` };
      }
      if (parsed.name === "--name") name = parsed.value;
      if (parsed.name === "--ref") ref = parsed.value;
      if (parsed.name === "--sparse") sparse = parsed.value;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", message: `unknown marketplace add option: ${arg}` };
    positional.push(arg);
  }
  if (positional.length !== 1) {
    return { kind: "error", message: "plugin marketplace add requires exactly one source" };
  }
  return {
    kind: "marketplace-add",
    source: positional[0]!,
    ...(name !== undefined ? { name } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(sparse !== undefined ? { sparse } : {}),
    force,
  };
}

function parseMarketplaceRemove(args: readonly string[]): AgenCPluginCliCommand {
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
    return args[0] === "--help" || args[0] === "-h"
      ? { kind: "help", text: formatAgenCPluginCliHelpText() }
      : { kind: "error", message: "plugin marketplace remove requires exactly one name" };
  }
  return { kind: "marketplace-remove", name: args[0]! };
}

function parseMarketplaceUpgrade(args: readonly string[]): AgenCPluginCliCommand {
  if (args.length === 0) return { kind: "marketplace-upgrade" };
  if (args.length === 1 && args[0] !== "--help" && args[0] !== "-h") {
    return { kind: "marketplace-upgrade", name: args[0]! };
  }
  if (args.length === 1) return { kind: "help", text: formatAgenCPluginCliHelpText() };
  return { kind: "error", message: "plugin marketplace upgrade accepts at most one name" };
}

function parseValueOption(
  args: readonly string[],
  index: number,
  arg: string,
  names: readonly string[],
): { readonly name: string; readonly value: string; readonly nextIndex: number } | null {
  for (const name of names) {
    if (arg === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { name, value: "", nextIndex: index };
      }
      return { name, value, nextIndex: index + 1 };
    }
    if (arg.startsWith(`${name}=`)) {
      return { name, value: arg.slice(name.length + 1), nextIndex: index };
    }
  }
  return null;
}

function parseScope(value: string): PluginScope | null {
  return value === "user" || value === "project" || value === "local" ? value : null;
}

function formatValidationResult(result: ValidationResult): string {
  const kind = result.success ? "Valid" : "Invalid";
  const lines = [`${kind} ${result.fileType}: ${result.filePath}`];
  if (result.errors.length > 0) {
    lines.push("Errors:");
    lines.push(...result.errors.map((error) => `- ${error.path}: ${error.message}`));
  }
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    lines.push(...result.warnings.map((warning) => `- ${warning.path}: ${warning.message}`));
  }
  return lines.join("\n");
}
