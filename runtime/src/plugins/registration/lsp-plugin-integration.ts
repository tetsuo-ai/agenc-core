import type { LspServerConfigInput } from "../../config/schema.js";
import type { LoadedPlugin } from "../loader.js";
import { getPluginDataDir } from "../directories.js";
import {
  loadRuntimePlugins,
  substitutePluginTemplate,
  type PluginRuntimeLoadOptions,
} from "./common.js";

export interface PluginLspRegistrationOptions extends PluginRuntimeLoadOptions {
  readonly plugins?: readonly LoadedPlugin[];
  readonly sessionId?: string;
}

let pluginLspCache: Promise<Readonly<Record<string, LspServerConfigInput>>> | null = null;

function substituteStringRecord(
  plugin: LoadedPlugin,
  value: Readonly<Record<string, string>> | undefined,
  options: PluginLspRegistrationOptions,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      substitutePluginTemplate(entry, plugin, {
        sessionId: options.sessionId,
        exposeSensitive: true,
      }),
    ]),
  );
}

export function resolvePluginLspEnvironment(
  plugin: LoadedPlugin,
  server: LspServerConfigInput,
  options: PluginLspRegistrationOptions = {},
): LspServerConfigInput {
  return {
    ...server,
    command: substitutePluginTemplate(server.command, plugin, {
      sessionId: options.sessionId,
      exposeSensitive: true,
    }),
    ...(server.args !== undefined
      ? {
          args: server.args.map((arg) =>
            substitutePluginTemplate(arg, plugin, {
              sessionId: options.sessionId,
              exposeSensitive: true,
            }),
          ),
        }
      : {}),
    env: {
      AGENC_PLUGIN_ROOT: plugin.root,
      AGENC_PLUGIN_DATA: getPluginDataDir(plugin.source),
      AGENC_PLUGIN_NAME: plugin.name,
      ...(substituteStringRecord(plugin, server.env, options) ?? {}),
    },
    ...(server.workspaceFolder !== undefined
      ? {
          workspaceFolder: substitutePluginTemplate(
            server.workspaceFolder,
            plugin,
            { sessionId: options.sessionId, exposeSensitive: true },
          ),
        }
      : { workspaceFolder: plugin.root }),
  };
}

export function addPluginScopeToLspServers(
  plugin: LoadedPlugin,
  servers: Readonly<Record<string, LspServerConfigInput>>,
  options: PluginLspRegistrationOptions = {},
): Readonly<Record<string, LspServerConfigInput>> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      `plugin:${plugin.name}:${name}`,
      resolvePluginLspEnvironment(plugin, server, options),
    ]),
  );
}

async function resolvePlugins(
  options: PluginLspRegistrationOptions,
): Promise<readonly LoadedPlugin[]> {
  return options.plugins ?? await loadRuntimePlugins(options);
}

export async function extractLspServersFromPlugins(
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
