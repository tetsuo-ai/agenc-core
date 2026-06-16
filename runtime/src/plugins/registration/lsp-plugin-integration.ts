import type { LspServerConfigInput } from "../../config/schema.js";
import { getPluginDataDir } from "../directories.js";
import { pluginScopedServerIdentifier } from "../identifier-normalization.js";
import type { LoadedPlugin, PluginLoadIssue } from "../loader.js";
import {
  loadRuntimePlugins,
  resolvePluginServerTemplate,
  type PluginRuntimeLoadOptions,
} from "./common.js";

export interface PluginLspRegistrationOptions extends PluginRuntimeLoadOptions {
  readonly plugins?: readonly LoadedPlugin[];
  readonly sessionId?: string;
  readonly errors?: PluginLoadIssue[];
}

let pluginLspCache: Promise<Readonly<Record<string, LspServerConfigInput>>> | null = null;

interface ServerResolutionIssues {
  readonly missingUserConfig: Set<string>;
  readonly missingEnv: Set<string>;
}

function createServerResolutionIssues(): ServerResolutionIssues {
  return {
    missingUserConfig: new Set(),
    missingEnv: new Set(),
  };
}

function resolveServerString(
  plugin: LoadedPlugin,
  value: string,
  options: PluginLspRegistrationOptions,
  issues: ServerResolutionIssues,
): string {
  const result = resolvePluginServerTemplate(value, plugin, {
    sessionId: options.sessionId,
    env: options.env,
  });
  result.missingUserConfig.forEach((key) => issues.missingUserConfig.add(key));
  result.missingEnv.forEach((key) => issues.missingEnv.add(key));
  return result.value;
}

function substituteStringRecord(
  plugin: LoadedPlugin,
  value: Readonly<Record<string, string>> | undefined,
  options: PluginLspRegistrationOptions,
  issues: ServerResolutionIssues,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolveServerString(plugin, entry, options, issues),
    ]),
  );
}

export function resolvePluginLspEnvironment(
  plugin: LoadedPlugin,
  server: LspServerConfigInput,
  options: PluginLspRegistrationOptions = {},
): LspServerConfigInput {
  return resolvePluginLspEnvironmentWithIssues(plugin, server, options).server;
}

function resolvePluginLspEnvironmentWithIssues(
  plugin: LoadedPlugin,
  server: LspServerConfigInput,
  options: PluginLspRegistrationOptions,
): { readonly server: LspServerConfigInput; readonly issues: ServerResolutionIssues } {
  const issues = createServerResolutionIssues();
  return {
    server: {
      ...server,
      command: resolveServerString(plugin, server.command, options, issues),
      ...(server.args !== undefined
        ? {
            args: server.args.map((arg) =>
              resolveServerString(plugin, arg, options, issues)
            ),
          }
        : {}),
      env: {
        AGENC_PLUGIN_ROOT: plugin.root,
        AGENC_PLUGIN_DATA: getPluginDataDir(plugin.source),
        AGENC_PLUGIN_NAME: plugin.name,
        ...(substituteStringRecord(plugin, server.env, options, issues) ?? {}),
      },
      ...(server.workspaceFolder !== undefined
        ? {
            workspaceFolder: resolveServerString(
              plugin,
              server.workspaceFolder,
              options,
              issues,
            ),
          }
        : { workspaceFolder: plugin.root }),
    },
    issues,
  };
}

function reportServerIssues(
  plugin: LoadedPlugin,
  serverName: string,
  issues: ServerResolutionIssues,
  options: PluginLspRegistrationOptions,
): boolean {
  const missingUserConfig = [...issues.missingUserConfig].sort();
  const missingEnv = [...issues.missingEnv].sort();
  if (missingUserConfig.length === 0 && missingEnv.length === 0) return false;
  if (missingUserConfig.length > 0) {
    options.errors?.push({
      type: "lsp",
      source: `plugin:${plugin.name}`,
      plugin: plugin.name,
      path: serverName,
      message: `Missing user configuration values: ${missingUserConfig.join(", ")}`,
    });
  }
  if (missingEnv.length > 0) {
    options.errors?.push({
      type: "lsp",
      source: `plugin:${plugin.name}`,
      plugin: plugin.name,
      path: serverName,
      message: `Missing environment variables: ${missingEnv.join(", ")}`,
    });
  }
  return true;
}

function addPluginScopeToLspServers(
  plugin: LoadedPlugin,
  servers: Readonly<Record<string, LspServerConfigInput>>,
  options: PluginLspRegistrationOptions = {},
): Readonly<Record<string, LspServerConfigInput>> {
  const scoped: Record<string, LspServerConfigInput> = {};
  for (const [name, server] of Object.entries(servers)) {
    const resolved = resolvePluginLspEnvironmentWithIssues(plugin, server, options);
    if (reportServerIssues(plugin, name, resolved.issues, options)) continue;
    scoped[pluginScopedServerIdentifier(plugin.name, name)] = resolved.server;
  }
  return scoped;
}

async function resolvePlugins(
  options: PluginLspRegistrationOptions,
): Promise<readonly LoadedPlugin[]> {
  return options.plugins ?? await loadRuntimePlugins(options);
}

async function extractLspServersFromPlugins(
  plugins: readonly LoadedPlugin[],
  options: PluginLspRegistrationOptions = {},
): Promise<Readonly<Record<string, LspServerConfigInput>>> {
  return Object.assign(
    {},
    ...plugins.map((plugin) =>
      addPluginScopeToLspServers(plugin, plugin.lspServers, options),
    ),
  ) as Readonly<Record<string, LspServerConfigInput>>;
}

export async function loadPluginLspServers(
  options: PluginLspRegistrationOptions = {},
): Promise<Readonly<Record<string, LspServerConfigInput>>> {
  const plugins = await resolvePlugins(options);
  return extractLspServersFromPlugins(plugins, options);
}

export async function getPluginLspServers(): Promise<Readonly<Record<string, LspServerConfigInput>>> {
  pluginLspCache ??= loadPluginLspServers();
  return pluginLspCache;
}

export function clearPluginLspServerCache(): void {
  pluginLspCache = null;
}
