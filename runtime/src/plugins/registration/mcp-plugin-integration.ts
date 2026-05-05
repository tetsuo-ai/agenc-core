import type { McpServerConfig } from "../../config/schema.js";
import type { LoadedPlugin } from "../loader.js";
import { getPluginDataDir } from "../directories.js";
import {
  loadRuntimePlugins,
  substitutePluginTemplate,
  type PluginRuntimeLoadOptions,
} from "./common.js";

export interface PluginMcpRegistrationOptions extends PluginRuntimeLoadOptions {
  readonly plugins?: readonly LoadedPlugin[];
  readonly sessionId?: string;
}

export interface PluginChannelRegistration {
  readonly plugin: string;
  readonly server: string;
  readonly displayName?: string;
  readonly configured: boolean;
}

let pluginMcpCache: Promise<Readonly<Record<string, McpServerConfig>>> | null = null;

function substituteStringRecord(
  plugin: LoadedPlugin,
  value: Readonly<Record<string, string>> | undefined,
  options: PluginMcpRegistrationOptions,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      substitutePluginTemplate(entry, plugin, { sessionId: options.sessionId }),
    ]),
  );
}

function pluginEnvironment(plugin: LoadedPlugin): Readonly<Record<string, string>> {
  return {
    AGENC_PLUGIN_ROOT: plugin.root,
    AGENC_PLUGIN_DATA: getPluginDataDir(plugin.source),
    AGENC_PLUGIN_NAME: plugin.name,
  };
}

export function resolvePluginMcpEnvironment(
  plugin: LoadedPlugin,
  server: McpServerConfig,
  options: PluginMcpRegistrationOptions = {},
): McpServerConfig {
  const env = {
    ...pluginEnvironment(plugin),
    ...(substituteStringRecord(plugin, server.env, options) ?? {}),
  };
  return {
    ...server,
    ...(server.command !== undefined
      ? {
          command: substitutePluginTemplate(server.command, plugin, {
            sessionId: options.sessionId,
          }),
        }
      : {}),
    ...(server.args !== undefined
      ? {
          args: server.args.map((arg) =>
            substitutePluginTemplate(arg, plugin, { sessionId: options.sessionId }),
          ),
        }
      : {}),
    ...(server.endpoint !== undefined
      ? {
          endpoint: substitutePluginTemplate(server.endpoint, plugin, {
            sessionId: options.sessionId,
          }),
        }
      : {}),
    ...(server.headers !== undefined
      ? { headers: substituteStringRecord(plugin, server.headers, options) }
      : {}),
    ...(server.cwd !== undefined
      ? {
          cwd: substitutePluginTemplate(server.cwd, plugin, {
            sessionId: options.sessionId,
          }),
        }
      : server.command !== undefined
        ? { cwd: plugin.root }
        : {}),
    env,
  };
}

export function addPluginScopeToServers(
  plugin: LoadedPlugin,
  servers: Readonly<Record<string, McpServerConfig>>,
  options: PluginMcpRegistrationOptions = {},
): Readonly<Record<string, McpServerConfig>> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      `plugin:${plugin.name}:${name}`,
      resolvePluginMcpEnvironment(plugin, server, options),
    ]),
  );
}

async function resolvePlugins(
  options: PluginMcpRegistrationOptions,
): Promise<readonly LoadedPlugin[]> {
  return options.plugins ?? await loadRuntimePlugins(options);
}

export async function extractMcpServersFromPlugins(
  plugins: readonly LoadedPlugin[],
  options: PluginMcpRegistrationOptions = {},
): Promise<Readonly<Record<string, McpServerConfig>>> {
  return Object.assign(
    {},
    ...plugins.map((plugin) =>
      addPluginScopeToServers(plugin, plugin.mcpServers, options),
    ),
  ) as Readonly<Record<string, McpServerConfig>>;
}

export async function loadPluginMcpServers(
  options: PluginMcpRegistrationOptions = {},
): Promise<Readonly<Record<string, McpServerConfig>>> {
  const plugins = await resolvePlugins(options);
  return extractMcpServersFromPlugins(plugins, options);
}

export async function getPluginMcpServers(): Promise<Readonly<Record<string, McpServerConfig>>> {
  pluginMcpCache ??= loadPluginMcpServers();
  return pluginMcpCache;
}

export function clearPluginMcpServerCache(): void {
  pluginMcpCache = null;
}

export function getUnconfiguredChannels(
  plugin: LoadedPlugin,
): readonly PluginChannelRegistration[] {
  return (plugin.manifest.channels ?? []).map((channel) => ({
    plugin: plugin.name,
    server: channel.server,
    ...(channel.displayName !== undefined ? { displayName: channel.displayName } : {}),
    configured: channel.userConfig === undefined ||
      Object.keys(channel.userConfig).every((key) =>
        plugin.settings !== undefined &&
        Object.prototype.hasOwnProperty.call(plugin.settings, key),
      ),
  })).filter((channel) => !channel.configured);
}

export function registerToolProvider(
  target: {
    readonly registerTool?: (name: string, config: McpServerConfig) => void;
    readonly registerMcpServer?: (name: string, config: McpServerConfig) => void;
  },
  servers: Readonly<Record<string, McpServerConfig>>,
): void {
  for (const [name, config] of Object.entries(servers)) {
    if (target.registerTool) {
      target.registerTool(name, config);
    } else {
      target.registerMcpServer?.(name, config);
    }
  }
}
