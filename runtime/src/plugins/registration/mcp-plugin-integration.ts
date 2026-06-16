import type { McpServerConfig } from "../../config/schema.js";
import { pluginScopedServerIdentifier } from "../identifier-normalization.js";
import type { LoadedPlugin, PluginLoadIssue } from "../loader.js";
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

let pluginMcpCache: Promise<Readonly<Record<string, McpServerConfig>>> | null = null;

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
  options: PluginMcpRegistrationOptions,
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
  options: PluginMcpRegistrationOptions,
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

export function resolvePluginMcpEnvironment(
  plugin: LoadedPlugin,
  server: McpServerConfig,
  options: PluginMcpRegistrationOptions = {},
): McpServerConfig {
  return resolvePluginMcpEnvironmentWithIssues(plugin, server, options).server;
}

function resolvePluginMcpEnvironmentWithIssues(
  plugin: LoadedPlugin,
  server: McpServerConfig,
  options: PluginMcpRegistrationOptions,
): { readonly server: McpServerConfig; readonly issues: ServerResolutionIssues } {
  const issues = createServerResolutionIssues();
  const env = substituteStringRecord(plugin, server.env, options, issues);
  return {
    server: {
      ...server,
      ...(server.command !== undefined
        ? { command: resolveServerString(plugin, server.command, options, issues) }
        : {}),
      ...(server.args !== undefined
        ? {
            args: server.args.map((arg) =>
              resolveServerString(plugin, arg, options, issues)
            ),
          }
        : {}),
      ...(server.endpoint !== undefined
        ? { endpoint: resolveServerString(plugin, server.endpoint, options, issues) }
        : {}),
      ...(server.headers !== undefined
        ? { headers: substituteStringRecord(plugin, server.headers, options, issues) }
        : {}),
      ...(server.cwd !== undefined
        ? { cwd: resolveServerString(plugin, server.cwd, options, issues) }
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
      source: `plugin:${plugin.name}`,
      plugin: plugin.name,
      path: serverName,
      message: `Missing user configuration values: ${missingUserConfig.join(", ")}`,
    });
  }
  if (missingEnv.length > 0) {
    options.errors?.push({
      type: "mcp",
      source: `plugin:${plugin.name}`,
      plugin: plugin.name,
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
    source: `plugin:${plugin.name}`,
    plugin: plugin.name,
    path: serverName,
    message: issue.message,
  });
}

function addPluginScopeToServers(
  plugin: LoadedPlugin,
  servers: Readonly<Record<string, McpServerConfig>>,
  options: PluginMcpRegistrationOptions = {},
): Readonly<Record<string, McpServerConfig>> {
  const scoped: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    const scopedName = pluginScopedServerIdentifier(plugin.name, name);
    const resolved = resolvePluginMcpEnvironmentWithIssues(plugin, server, options);
    if (reportServerIssues(plugin, name, resolved.issues, options)) continue;
    const sandboxed = resolvePluginMcpSandboxedServer(
      plugin,
      name,
      resolved.server,
      { scopedServerName: scopedName },
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

async function extractMcpServersFromPlugins(
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
      Object.entries(channel.userConfig).every(([key, config]) =>
        config.required !== true ||
        pluginSettingValue(plugin, key, { exposeSensitive: true }) !== undefined,
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
