import type { McpServerConfig } from "../../config/schema.js";
import { pluginScopedServerIdentifier } from "../identifier-normalization.js";
import {
  isRepositoryControlledPlugin,
  type LoadedPlugin,
  type PluginLoadIssue,
} from "../loader.js";
import {
  resolvePluginMcpSandboxedServer,
  type PluginMcpSandboxIssue,
} from "../sandbox.js";
import {
  loadRuntimePlugins,
  pluginSettingValue,
  resolvePluginServerTemplate,
  type PluginRuntimeLoadOptions,
} from "./common.js";
import {
  loadPluginOptions,
  type PluginOptionSchema,
} from "../../utils/plugins/pluginOptionsStorage.js";
import {
  loadMcpServerUserConfig,
  type UserConfigSchema,
} from "../../utils/plugins/mcpbHandler.js";
import type { PluginConfigStoredValue } from "../../utils/plugins/pluginConfigAuthority.js";
import type { PluginUserConfigOption } from "../manifest-schema.js";
import { getPluginDataDir } from "../directories.js";

export interface PluginMcpRegistrationOptions extends PluginRuntimeLoadOptions {
  readonly plugins?: readonly LoadedPlugin[];
  readonly sessionId?: string;
  readonly errors?: PluginLoadIssue[];
}

export interface PluginChannelRegistration {
  readonly plugin: string;
  readonly server: string;
  readonly displayName?: string;
  readonly configured: boolean;
}

interface ServerResolutionIssues {
  readonly missingUserConfig: Set<string>;
  readonly missingEnv: Set<string>;
}

interface SchemaOwnedServerUserConfig {
  readonly values: Readonly<Record<string, PluginConfigStoredValue>>;
  readonly schema: Readonly<Record<string, PluginUserConfigOption>>;
}

function schemaOwnedServerUserConfig(
  plugin: LoadedPlugin,
  serverName: string,
): SchemaOwnedServerUserConfig | undefined {
  const topLevelSchema = plugin.manifest.userConfig;
  const channelSchema = plugin.manifest.channels?.find(
    channel => channel.server === serverName,
  )?.userConfig;
  if (topLevelSchema === undefined && channelSchema === undefined) {
    return undefined;
  }

  const topLevel = topLevelSchema === undefined
    ? undefined
    : loadPluginOptions(
        plugin.id,
        topLevelSchema as unknown as PluginOptionSchema,
      );
  const channel = channelSchema === undefined
    ? undefined
    : loadMcpServerUserConfig(
        plugin.id,
        serverName,
        channelSchema as unknown as UserConfigSchema,
      );
  return {
    values: { ...topLevel, ...channel },
    schema: { ...topLevelSchema, ...channelSchema },
  };
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
  options: PluginMcpRegistrationOptions,
  issues: ServerResolutionIssues,
  userConfig?: SchemaOwnedServerUserConfig,
): string {
  const result = resolvePluginServerTemplate(value, plugin, {
    sessionId: options.sessionId,
    env: options.env,
    ...(options.pluginStorageRoot !== undefined
      ? { pluginStorageRoot: options.pluginStorageRoot }
      : {}),
    ...(userConfig === undefined
      ? {}
      : {
          schemaOwnedValues: userConfig.values,
          schema: userConfig.schema,
        }),
  });
  result.missingUserConfig.forEach((key) => issues.missingUserConfig.add(key));
  result.missingEnv.forEach((key) => issues.missingEnv.add(key));
  return result.value;
}

function substituteStringRecord(
  plugin: LoadedPlugin,
  value: Readonly<Record<string, string>> | undefined,
  options: PluginMcpRegistrationOptions,
  issues: ServerResolutionIssues,
  userConfig?: SchemaOwnedServerUserConfig,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolveServerString(plugin, entry, options, issues, userConfig),
    ]),
  );
}

export function resolvePluginMcpEnvironment(
  plugin: LoadedPlugin,
  server: McpServerConfig,
  options: PluginMcpRegistrationOptions,
): McpServerConfig {
  return resolvePluginMcpEnvironmentWithIssues(plugin, server, options).server;
}

function resolvePluginMcpEnvironmentWithIssues(
  plugin: LoadedPlugin,
  server: McpServerConfig,
  options: PluginMcpRegistrationOptions,
  userConfig?: SchemaOwnedServerUserConfig,
): { readonly server: McpServerConfig; readonly issues: ServerResolutionIssues } {
  const issues = createServerResolutionIssues();
  const env = substituteStringRecord(
    plugin,
    server.env,
    options,
    issues,
    userConfig,
  );
  return {
    server: {
      ...server,
      ...(server.command !== undefined
        ? {
            command: resolveServerString(
              plugin,
              server.command,
              options,
              issues,
              userConfig,
            ),
          }
        : {}),
      ...(server.args !== undefined
        ? {
            args: server.args.map((arg) =>
              resolveServerString(plugin, arg, options, issues, userConfig)
            ),
          }
        : {}),
      ...(server.endpoint !== undefined
        ? {
            endpoint: resolveServerString(
              plugin,
              server.endpoint,
              options,
              issues,
              userConfig,
            ),
          }
        : {}),
      ...(server.headers !== undefined
        ? {
            headers: substituteStringRecord(
              plugin,
              server.headers,
              options,
              issues,
              userConfig,
            ),
          }
        : {}),
      ...(server.cwd !== undefined
        ? {
            cwd: resolveServerString(
              plugin,
              server.cwd,
              options,
              issues,
              userConfig,
            ),
          }
        : server.command !== undefined
          ? { cwd: plugin.root }
          : {}),
      ...(env !== undefined ? { env } : {}),
    },
    issues,
  };
}

function reportServerIssues(
  plugin: LoadedPlugin,
  serverName: string,
  issues: ServerResolutionIssues,
  options: PluginMcpRegistrationOptions,
): boolean {
  const missingUserConfig = [...issues.missingUserConfig].sort();
  const missingEnv = [...issues.missingEnv].sort();
  if (missingUserConfig.length === 0 && missingEnv.length === 0) return false;
  if (missingUserConfig.length > 0) {
    options.errors?.push({
      type: "mcp",
      source: `plugin:${plugin.id}`,
      plugin: plugin.id,
      path: serverName,
      message: `Missing user configuration values: ${missingUserConfig.join(", ")}`,
    });
  }
  if (missingEnv.length > 0) {
    options.errors?.push({
      type: "mcp",
      source: `plugin:${plugin.id}`,
      plugin: plugin.id,
      path: serverName,
      message: `Missing environment variables: ${missingEnv.join(", ")}`,
    });
  }
  return true;
}

function reportSandboxIssue(
  plugin: LoadedPlugin,
  serverName: string,
  issue: PluginMcpSandboxIssue,
  options: PluginMcpRegistrationOptions,
): void {
  options.errors?.push({
    type: "mcp",
    source: `plugin:${plugin.id}`,
    plugin: plugin.id,
    path: serverName,
    message: issue.message,
  });
}

function addPluginScopeToServers(
  plugin: LoadedPlugin,
  servers: Readonly<Record<string, McpServerConfig>>,
  options: PluginMcpRegistrationOptions,
): Readonly<Record<string, McpServerConfig>> {
  const scoped: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    const scopedName = pluginScopedServerIdentifier(plugin.id, name);
    const userConfig = schemaOwnedServerUserConfig(plugin, name);
    const resolved = resolvePluginMcpEnvironmentWithIssues(
      plugin,
      server,
      options,
      userConfig,
    );
    if (reportServerIssues(plugin, name, resolved.issues, options)) continue;
    const sandboxed = resolvePluginMcpSandboxedServer(
      plugin,
      name,
      resolved.server,
      {
        scopedServerName: scopedName,
        dataDir: getPluginDataDir(plugin.id, options.pluginStorageRoot),
      },
    );
    if ("issue" in sandboxed) {
      reportSandboxIssue(plugin, name, sandboxed.issue, options);
      continue;
    }
    scoped[scopedName] = sandboxed.server;
  }
  return scoped;
}

async function resolvePlugins(
  options: PluginMcpRegistrationOptions,
): Promise<readonly LoadedPlugin[]> {
  return options.plugins ?? await loadRuntimePlugins(options);
}

export interface PluginMcpServerRegistration {
  readonly name: string;
  readonly pluginName: string;
  readonly pluginSource: string;
  readonly serverName: string;
  readonly server: McpServerConfig;
}

async function extractMcpServerRegistrationsFromPlugins(
  plugins: readonly LoadedPlugin[],
  options: PluginMcpRegistrationOptions,
): Promise<readonly PluginMcpServerRegistration[]> {
  const registrations: PluginMcpServerRegistration[] = [];
  for (const plugin of plugins.filter(
    (candidate) => !isRepositoryControlledPlugin(candidate)
  )) {
    const scoped = addPluginScopeToServers(plugin, plugin.mcpServers, options);
    for (const serverName of Object.keys(plugin.mcpServers)) {
      const name = pluginScopedServerIdentifier(plugin.id, serverName);
      const server = scoped[name];
      if (server === undefined) continue;
      registrations.push({
        name,
        pluginName: plugin.id,
        pluginSource: plugin.source,
        serverName,
        server,
      });
    }
  }
  return Object.freeze(registrations);
}

export async function loadPluginMcpServerRegistrations(
  options: PluginMcpRegistrationOptions,
): Promise<readonly PluginMcpServerRegistration[]> {
  const plugins = await resolvePlugins(options);
  return extractMcpServerRegistrationsFromPlugins(plugins, options);
}

export async function loadPluginMcpServers(
  options: PluginMcpRegistrationOptions,
): Promise<Readonly<Record<string, McpServerConfig>>> {
  const registrations = await loadPluginMcpServerRegistrations(options);
  return Object.fromEntries(
    registrations.map(({ name, server }) => [name, server]),
  );
}

export function getUnconfiguredChannels(
  plugin: LoadedPlugin,
): readonly PluginChannelRegistration[] {
  return (plugin.manifest.channels ?? []).map((channel) => ({
    plugin: plugin.id,
    server: channel.server,
    ...(channel.displayName !== undefined ? { displayName: channel.displayName } : {}),
    configured: channel.userConfig === undefined || (() => {
      const userConfig = schemaOwnedServerUserConfig(plugin, channel.server);
      return Object.entries(channel.userConfig).every(([key, config]) =>
        config.required !== true ||
        pluginSettingValue(plugin, key, {
          exposeSensitive: true,
          schemaOwnedValues: userConfig?.values,
          schema: userConfig?.schema,
        }) !== undefined
      );
    })(),
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
