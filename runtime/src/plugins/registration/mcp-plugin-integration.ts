import type { McpServerConfig } from "../../config/schema.js";
import { join, relative } from "node:path";

/**
 * A plugin server config as the runtime carries it: the canonical config plus
 * the decoded sensitive values used for redaction. config.toml can never set
 * pluginSecretValues; only plugin resolution adds it.
 */
export type PluginMcpServerConfig = McpServerConfig & { readonly pluginSecretValues?: readonly string[] };
import { pluginScopedServerIdentifier } from "../identifier-normalization.js";
import {
  isRepositoryControlledPlugin,
  type LoadedPlugin,
  type PluginLoadIssue,
} from "../loader.js";
import {
  pathInsideOrEqual,
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
import { fingerprintPluginCatalogConfig, snapshotInstalledPluginOffThread } from "../../mcp-client/plugin-catalog-cache.js";

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
  readonly unsafeSensitive: Set<string>;
  readonly invalidTransportValues: Set<string>;
  readonly sensitiveValues: Set<string>;
}

interface SchemaOwnedServerUserConfig {
  readonly values: Readonly<Record<string, PluginConfigStoredValue>>;
  readonly schema: Readonly<Record<string, PluginUserConfigOption>>;
  readonly sensitiveKeys: ReadonlySet<string>;
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
        { fresh: true },
      );
  const channel = channelSchema === undefined
    ? undefined
    : loadMcpServerUserConfig(
        plugin.id,
        serverName,
        channelSchema as unknown as UserConfigSchema,
        { fresh: true },
      );
  const values = { ...topLevel, ...channel };
  return {
    values,
    schema: { ...topLevelSchema, ...channelSchema },
    sensitiveKeys: new Set(Object.keys(values).filter(key =>
      Object.hasOwn(channel ?? {}, key)
        ? channelSchema?.[key]?.sensitive === true
        : topLevelSchema?.[key]?.sensitive === true,
    )),
  };
}

function createServerResolutionIssues(): ServerResolutionIssues {
  return {
    missingUserConfig: new Set(),
    missingEnv: new Set(),
    unsafeSensitive: new Set(),
    invalidTransportValues: new Set(),
    sensitiveValues: new Set(),
  };
}

function resolveServerString(
  plugin: LoadedPlugin,
  value: string,
  options: PluginMcpRegistrationOptions,
  issues: ServerResolutionIssues,
  userConfig?: SchemaOwnedServerUserConfig,
  field = 'value',
): string {
  if (field === 'env' || field === 'headers') {
    for (const match of value.matchAll(/\$\{user_config\.([A-Za-z_][\w.-]*)\}/g)) {
      const key = match[1]!
      if (userConfig?.sensitiveKeys.has(key) !== true) continue
      const decoded = userConfig.values[key]
      for (const part of Array.isArray(decoded) ? decoded : [decoded]) {
        if (part !== undefined && String(part)) issues.sensitiveValues.add(String(part))
      }
    }
  }
  if (field !== 'env' && field !== 'headers') {
    for (const match of value.matchAll(/\$\{user_config\.([A-Za-z_][\w.-]*)\}/g)) {
      const key = match[1]!
      if (userConfig?.values[key] !== undefined
        ? userConfig.sensitiveKeys.has(key)
        : userConfig?.schema[key]?.sensitive === true) {
        issues.unsafeSensitive.add(`${key} in ${field}`)
      }
    }
    if (issues.unsafeSensitive.size > 0) return value
  }
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
  field = 'env',
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolveServerString(plugin, entry, options, issues, userConfig, field),
    ]),
  );
}

export function resolvePluginMcpEnvironment(
  plugin: LoadedPlugin,
  server: McpServerConfig,
  options: PluginMcpRegistrationOptions,
): PluginMcpServerConfig {
  return resolvePluginMcpEnvironmentWithIssues(plugin, server, options).server;
}

function resolvePluginMcpEnvironmentWithIssues(
  plugin: LoadedPlugin,
  server: McpServerConfig,
  options: PluginMcpRegistrationOptions,
  userConfig?: SchemaOwnedServerUserConfig,
): { readonly server: PluginMcpServerConfig; readonly issues: ServerResolutionIssues } {
  const issues = createServerResolutionIssues();
  const env = substituteStringRecord(
    plugin,
    server.env,
    options,
    issues,
    userConfig,
    'env',
  );
  const headers = substituteStringRecord(plugin, server.headers, options, issues, userConfig, 'headers');
  for (const [field, values] of [['env', env], ['headers', headers]] as const) {
    if (Object.values(values ?? {}).some(value => /[\u0000-\u001f\u007f]/u.test(value))) issues.invalidTransportValues.add(field);
  }
  return {
    server: {
      ...server,
      pluginSecretValues: [...issues.sensitiveValues],
      ...(server.oauth === undefined ? {} : {
        oauth: {
          ...server.oauth,
          ...(server.oauth.clientId === undefined ? {} : {
            clientId: resolveServerString(plugin, server.oauth.clientId, options, issues, userConfig, 'oauth.clientId'),
          }),
        },
      }),
      ...(server.command !== undefined
        ? {
            command: resolveServerString(
              plugin,
              server.command,
              options,
              issues,
              userConfig,
              'command',
            ),
          }
        : {}),
      ...(server.args !== undefined
        ? {
            args: server.args.map((arg) =>
              resolveServerString(plugin, arg, options, issues, userConfig, 'args')
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
              'endpoint',
            ),
          }
        : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(server.cwd !== undefined
        ? {
            cwd: resolveServerString(
              plugin,
              server.cwd,
              options,
              issues,
              userConfig,
              'cwd',
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
  const unsafeSensitive = [...issues.unsafeSensitive].sort((a, b) => a.localeCompare(b));
  const invalidTransportValues = [...issues.invalidTransportValues].sort((a, b) => a.localeCompare(b));
  if (missingUserConfig.length === 0 && missingEnv.length === 0 && unsafeSensitive.length === 0 && invalidTransportValues.length === 0) return false;
  if (invalidTransportValues.length > 0) {
    options.errors?.push({
      type: 'mcp', source: `plugin:${plugin.id}`, plugin: plugin.id, path: serverName,
      message: `Invalid MCP ${invalidTransportValues.join(' and ')} value`,
    });
  }
  if (unsafeSensitive.length > 0) {
    options.errors?.push({
      type: 'mcp', source: `plugin:${plugin.id}`, plugin: plugin.id, path: serverName,
      message: `Sensitive user configuration may only be used in MCP env values or headers: ${unsafeSensitive.join(', ')}`,
    });
  }
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
  userConfigFor: (serverName: string) => SchemaOwnedServerUserConfig | undefined =
    serverName => schemaOwnedServerUserConfig(plugin, serverName),
): Readonly<Record<string, McpServerConfig>> {
  const scoped: Record<string, McpServerConfig> = {};
  const scopedCounts = new Map<string, number>();
  for (const name of Object.keys(servers)) {
    const scopedName = pluginScopedServerIdentifier(plugin.id, name);
    scopedCounts.set(scopedName, (scopedCounts.get(scopedName) ?? 0) + 1);
  }
  for (const [name, server] of Object.entries(servers)) {
    const scopedName = pluginScopedServerIdentifier(plugin.id, name);
    if (scopedCounts.get(scopedName)! > 1) {
      options.errors?.push({ type: "mcp", source: `plugin:${plugin.id}`, plugin: plugin.id, message: "Plugin MCP server names have an ambiguous runtime identity." });
      continue;
    }
    const userConfig = userConfigFor(name);
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
  readonly pluginRoot: string;
  readonly snapshotRoot: string;
  readonly userConfigDigest?: string;
  readonly serverName: string;
  readonly server: McpServerConfig;
  /** Resolved against the installed root, as command policy saw it before snapshots. */
  readonly installationIdentity?: Pick<McpServerConfig, "command" | "args" | "cwd">;
  readonly version?: string;
  readonly digest: string;
  readonly eager: boolean;
  readonly idleTimeoutMs: number;
  readonly maxProcesses: number;
}

async function extractMcpServerRegistrationsFromPlugins(
  plugins: readonly LoadedPlugin[],
  options: PluginMcpRegistrationOptions,
): Promise<readonly PluginMcpServerRegistration[]> {
  const registrations: PluginMcpServerRegistration[] = [];
  for (const plugin of plugins.filter(
    (candidate) => !isRepositoryControlledPlugin(candidate)
  )) {
    let digest: string;
    let snapshotRoot: string;
    try {
      ({ digest, snapshotRoot } = await snapshotInstalledPluginOffThread(plugin.root, options.pluginStorageRoot));
    }
    catch (error) {
      options.errors?.push({
        type: "mcp", source: `plugin:${plugin.id}`, plugin: plugin.id,
        message: `Could not hash installed plugin content: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    // Resolve launch templates against the immutable bytes, before a shell
    // argument can embed an absolute path to the mutable installation.
    // The loader has already resolved an explicit cwd against the install
    // root. Rebase that path before sandbox containment checks the snapshot.
    const snapshotServers = Object.fromEntries(Object.entries(plugin.mcpServers).map(([name, server]) => [
      name,
      server.cwd !== undefined && pathInsideOrEqual(plugin.root, server.cwd)
        ? { ...server, cwd: join(snapshotRoot, relative(plugin.root, server.cwd)) }
        : server,
    ]));
    // Each settings read reaches secure storage. The launch values, the
    // installed-path identity and the catalog digest share one read per server.
    const userConfigs = new Map<string, SchemaOwnedServerUserConfig | undefined>();
    const userConfigFor = (serverName: string): SchemaOwnedServerUserConfig | undefined => {
      if (!userConfigs.has(serverName)) userConfigs.set(serverName, schemaOwnedServerUserConfig(plugin, serverName));
      return userConfigs.get(serverName);
    };
    const scoped = addPluginScopeToServers({ ...plugin, root: snapshotRoot }, snapshotServers, options, userConfigFor);
    const lifecycleEntry = plugin.configEntry ?? options.config?.plugins?.plugins?.[plugin.id];
    for (const serverName of Object.keys(plugin.mcpServers)) {
      const name = pluginScopedServerIdentifier(plugin.id, serverName);
      const server = scoped[name];
      if (server === undefined) continue;
      const userConfig = userConfigFor(serverName);
      const installation = resolvePluginMcpEnvironmentWithIssues(
        plugin,
        plugin.mcpServers[serverName]!,
        options,
        userConfig,
      ).server;
      registrations.push({
        name,
        pluginName: plugin.id,
        pluginSource: plugin.source,
        pluginRoot: plugin.root,
        snapshotRoot,
        userConfigDigest: fingerprintPluginCatalogConfig(userConfig?.values ?? {}),
        serverName,
        server,
        installationIdentity: {
          ...(installation.command !== undefined ? { command: installation.command } : {}),
          ...(installation.args !== undefined ? { args: installation.args } : {}),
          ...(installation.cwd !== undefined ? { cwd: installation.cwd } : {}),
        },
        ...(plugin.version !== undefined ? { version: plugin.version } : {}),
        digest,
        eager: plugin.manifest.channels?.some(channel => channel.server === serverName) === true ||
          plugin.manifest.mcpEagerServers?.includes(serverName) === true ||
          lifecycleEntry?.mcp_servers?.[serverName]?.eager === true,
        idleTimeoutMs: lifecycleEntry?.mcp_servers?.[serverName]?.idle_timeout_ms ??
          options.config?.plugins?.mcp_idle_timeout_ms ?? 600_000,
        maxProcesses: options.config?.plugins?.mcp_max_processes ?? 8,
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

export interface PluginMcpServerInstallation {
  readonly pluginRoot: string;
  readonly snapshotRoot: string;
  readonly digest: string;
  /** The plugin server's own enabled flag, before session overrides. */
  readonly enabled: boolean;
}

/**
 * Identify one installed plugin MCP server without resolving settings: only
 * the target plugin is hashed, and no plugin settings or secure storage are read.
 */
export async function loadPluginMcpServerInstallation(
  options: PluginMcpRegistrationOptions & {
    readonly name: string;
    readonly pluginName: string;
    readonly serverName: string;
  },
): Promise<PluginMcpServerInstallation | undefined> {
  for (const plugin of await resolvePlugins(options)) {
    if (isRepositoryControlledPlugin(plugin) || plugin.id !== options.pluginName) continue;
    const server = Object.hasOwn(plugin.mcpServers, options.serverName)
      ? plugin.mcpServers[options.serverName] : undefined;
    // Registration skips a server whose scoped name is ambiguous.
    const scopedNames = Object.keys(plugin.mcpServers).filter(serverName =>
      pluginScopedServerIdentifier(plugin.id, serverName) === options.name);
    if (server === undefined || scopedNames.length !== 1 || scopedNames[0] !== options.serverName) continue;
    const { digest, snapshotRoot } = await snapshotInstalledPluginOffThread(plugin.root, options.pluginStorageRoot);
    return { pluginRoot: plugin.root, snapshotRoot, digest, enabled: server.enabled !== false };
  }
  return undefined;
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
