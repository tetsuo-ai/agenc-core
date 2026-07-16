import { join } from "node:path";

import {
  assertAgentRoleWorkspaceMatches,
  type AgentRoleWorkspace,
} from "../../agents/role.js";
import type { AgenCConfig, HooksMap, LspServerConfigInput, McpServerConfig } from "../../config/schema.js";
import type { Command } from "../../commands.js";
import type { SlashCommandContext } from "../../commands/types.js";
import {
  requireAgentDefinitionRoleFingerprint,
  type PluginAgentDefinition,
} from "../../tools/AgentTool/loadAgentsDir.js";
import { isRecord } from "../../utils/record.js";
import { loadPlugins, type LoadedPlugin, type PluginLoadIssue, type PluginLoadResult } from "../loader.js";
import {
  clearRuntimePluginLoadCache,
  toPluginLoaderOptions,
  type PluginRuntimeLoadOptions,
} from "./common.js";
import {
  clearPluginAgentCache,
  loadPluginAgents,
  setActivePluginAgentSnapshot,
} from "./load-plugin-agents.js";
import {
  clearPluginCommandCache,
  clearPluginSkillsCache,
  loadPluginCommands,
  loadPluginSkills,
  setActivePluginCommandSnapshot,
  setActivePluginSkillSnapshot,
} from "./load-plugin-commands.js";
import { clearPluginHookCache, loadPluginHooks } from "./load-plugin-hooks.js";
import { clearPluginLspServerCache, loadPluginLspServers } from "./lsp-plugin-integration.js";
import { clearPluginMcpServerCache, loadPluginMcpServers } from "./mcp-plugin-integration.js";
import {
  clearPluginOutputStyleCache,
  loadPluginOutputStyles,
  type PluginOutputStyle,
} from "./load-plugin-output-styles.js";

export interface PluginRegistrationSnapshot {
  readonly enabled_count: number;
  readonly disabled_count: number;
  readonly command_count: number;
  readonly agent_count: number;
  readonly hook_count: number;
  readonly mcp_count: number;
  readonly lsp_count: number;
  readonly output_style_count: number;
  readonly error_count: number;
  readonly commands: readonly Command[];
  readonly skills: readonly Command[];
  readonly agents: readonly PluginAgentDefinition[];
  readonly mcp_servers: Readonly<Record<string, McpServerConfig>>;
  readonly lsp_servers: Readonly<Record<string, LspServerConfigInput>>;
  readonly hooks?: HooksMap;
  readonly outputStyles: readonly PluginOutputStyle[];
  readonly loadResult: PluginLoadResult;
}

function countHooks(hooks: HooksMap | undefined): number {
  if (!hooks) return 0;
  return Object.values(hooks).reduce(
    (sum, matchers) =>
      sum + matchers.reduce((inner, matcher) => inner + matcher.hooks.length, 0),
    0,
  );
}

export async function refreshPluginRegistrations(
  options: PluginRuntimeLoadOptions = {},
): Promise<PluginRegistrationSnapshot> {
  const loadResult = await loadPlugins(toPluginLoaderOptions(options));
  const registrationErrors: PluginLoadIssue[] = [];
  const plugins = loadResult.enabled;
  const [
    commands,
    skills,
    agents,
    hooks,
    mcpServers,
    lspServers,
    outputStyles,
  ] = await Promise.all([
    loadPluginCommands({ ...options, plugins }),
    loadPluginSkills({ ...options, plugins }),
    loadPluginAgents({ ...options, plugins }),
    loadPluginHooks({ ...options, plugins }),
    loadPluginMcpServers({ ...options, plugins, errors: registrationErrors }),
    loadPluginLspServers({ ...options, plugins, errors: registrationErrors }),
    loadPluginOutputStyles({ ...options, plugins }),
  ]);
  const combinedLoadResult: PluginLoadResult =
    registrationErrors.length === 0
      ? loadResult
      : {
          ...loadResult,
          errors: [...loadResult.errors, ...registrationErrors],
        };

  return {
    enabled_count: loadResult.enabled.length,
    disabled_count: loadResult.disabled.length,
    command_count: commands.length + skills.length,
    agent_count: agents.length,
    hook_count: countHooks(hooks),
    mcp_count: Object.keys(mcpServers).length,
    lsp_count: Object.keys(lspServers).length,
    output_style_count: outputStyles.length,
    error_count: combinedLoadResult.errors.length,
    commands,
    skills,
    agents,
    mcp_servers: mcpServers,
    lsp_servers: lspServers,
    ...(hooks !== undefined ? { hooks } : {}),
    outputStyles,
    loadResult: combinedLoadResult,
  };
}

function isPluginAgent(value: unknown): boolean {
  return isRecord(value) && value.source === "plugin";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

function agentRoleWorkspaceEnvelopeId(value: unknown): string | undefined {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  const record = value as unknown as Record<string, unknown>;
  return typeof record.agentRoleWorkspaceId === "string"
    ? record.agentRoleWorkspaceId
    : undefined;
}

function mergeAgentDefinitions(
  current: Record<string, unknown>,
  pluginAgents: readonly PluginAgentDefinition[],
  workspace: AgentRoleWorkspace,
): Record<string, unknown> {
  const rawDefinitions = current.agentDefinitions;
  const recordedWorkspaceId = agentRoleWorkspaceEnvelopeId(rawDefinitions);
  assertAgentRoleWorkspaceMatches(
    workspace,
    recordedWorkspaceId,
  );
  const currentDefinitions = isRecord(rawDefinitions) ? rawDefinitions : {};
  const scopedPluginAgents = pluginAgents.map((agent) => ({
    ...agent,
    agentRoleFingerprint: requireAgentDefinitionRoleFingerprint(agent),
  }));
  return {
    ...currentDefinitions,
    agentRoleWorkspaceId: workspace.id,
    allAgents: [
      ...arrayValue(currentDefinitions.allAgents).filter((agent) => !isPluginAgent(agent)),
      ...scopedPluginAgents,
    ],
    activeAgents: [
      ...arrayValue(currentDefinitions.activeAgents).filter((agent) => !isPluginAgent(agent)),
      ...scopedPluginAgents,
    ],
  };
}

function pluginErrorFromIssue(issue: PluginLoadIssue): Record<string, unknown> {
  switch (issue.type) {
    case "path-not-found":
      return {
        type: "path-not-found",
        source: issue.source,
        plugin: issue.plugin,
        path: issue.path ?? issue.source,
        component: issue.component ?? "commands",
      };
    case "manifest":
      return {
        type: "manifest-validation-error",
        source: issue.source,
        plugin: issue.plugin,
        manifestPath: issue.path ?? issue.source,
        validationErrors: [issue.message],
      };
    case "hooks":
      return {
        type: "hook-load-failed",
        source: issue.source,
        plugin: issue.plugin ?? "unknown",
        hookPath: issue.path ?? issue.source,
        reason: issue.message,
      };
    case "mcp":
      return {
        type: "mcp-config-invalid",
        source: issue.source,
        plugin: issue.plugin ?? "unknown",
        serverName: issue.path ?? "unknown",
        validationError: issue.message,
      };
    case "lsp":
      return {
        type: "lsp-config-invalid",
        source: issue.source,
        plugin: issue.plugin ?? "unknown",
        serverName: issue.path ?? "unknown",
        validationError: issue.message,
      };
    case "settings":
      return {
        type: "component-load-failed",
        source: issue.source,
        plugin: issue.plugin ?? "unknown",
        component: "settings",
        path: issue.path ?? issue.source,
        reason: issue.message,
      };
    case "dependency":
      return {
        type: "plugin-dependency-invalid",
        source: issue.source,
        plugin: issue.plugin ?? "unknown",
        reason: issue.message,
      };
  }
}

function appStateHooksConfig(plugin: LoadedPlugin): HooksMap | undefined {
  let hooks: HooksMap | undefined;
  for (const source of plugin.hookSources) {
    const next: Record<string, NonNullable<HooksMap[string]>> = {};
    for (const [event, matchers] of Object.entries(hooks ?? {})) {
      next[event] = [...matchers];
    }
    for (const [event, matchers] of Object.entries(source.hooks)) {
      next[event] = [...(next[event] ?? []), ...matchers];
    }
    hooks = next;
  }
  return hooks;
}

function appStatePlugin(plugin: LoadedPlugin): Record<string, unknown> {
  const { settings: _settings, ...manifest } = plugin.manifest;
  return {
    name: plugin.name,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    root: plugin.root,
    source: plugin.source,
    enabled: plugin.enabled,
    manifest,
    ...(plugin.manifestPath !== undefined ? { manifestPath: plugin.manifestPath } : {}),
    ...(plugin.commandsPath !== undefined ? { commandsPath: plugin.commandsPath } : {}),
    commands: [...plugin.commands],
    ...(plugin.agentsPath !== undefined ? { agentsPath: plugin.agentsPath } : {}),
    ...(plugin.skillsPath !== undefined ? { skillsPath: plugin.skillsPath } : {}),
    ...(plugin.outputStylesPath !== undefined ? { outputStylesPath: plugin.outputStylesPath } : {}),
    hookSources: [...plugin.hookSources],
    appConnectorIds: [...plugin.appConnectorIds],
    errors: [...plugin.errors],
    path: plugin.root,
    repository: plugin.source,
    commandsPaths: [...plugin.commandsPaths],
    agentsPaths: [...plugin.agentsPaths],
    skillsPaths: [...plugin.skillsPaths],
    outputStylesPaths: [...plugin.outputStylesPaths],
    ...(appStateHooksConfig(plugin) !== undefined
      ? { hooksConfig: appStateHooksConfig(plugin) }
      : {}),
    mcpServers: { ...plugin.mcpServers },
    lspServers: { ...plugin.lspServers },
  };
}

function dedupeErrors(errors: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const error of errors) {
    const key = JSON.stringify(error);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(error);
  }
  return out;
}

function pluginErrorKey(error: unknown): string {
  if (!isRecord(error)) return JSON.stringify(error);
  const type = typeof error.type === "string" ? error.type : "unknown";
  const source = typeof error.source === "string" ? error.source : "unknown";
  const detail = typeof error.error === "string" ? `:${error.error}` : "";
  return `${type}:${source}${detail}`;
}

function shouldPreserveExistingPluginError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const source = typeof error.source === "string" ? error.source : undefined;
  const type = typeof error.type === "string" ? error.type : undefined;
  return source === "lsp-manager" || source?.startsWith("plugin:") === true ||
    type === "lsp-manager";
}

function mergePluginErrors(
  existing: readonly unknown[],
  fresh: readonly unknown[],
): unknown[] {
  const freshKeys = new Set(fresh.map(pluginErrorKey));
  return dedupeErrors([
    ...existing
      .filter(shouldPreserveExistingPluginError)
      .filter((error) => !freshKeys.has(pluginErrorKey(error))),
    ...fresh,
  ]);
}

function updatePluginAppState(
  setAppState: ((updater: (prev: unknown) => unknown) => void) | undefined,
  snapshot: PluginRegistrationSnapshot,
  workspace: AgentRoleWorkspace,
): void {
  if (!setAppState) return;
  setAppState((prev) => {
    const current = isRecord(prev) ? prev : {};
    const currentPlugins = isRecord(current.plugins) ? current.plugins : {};
    const currentMcp = isRecord(current.mcp) ? current.mcp : {};
    const currentReconnectKey =
      typeof currentMcp.pluginReconnectKey === "number"
        ? currentMcp.pluginReconnectKey
        : 0;
    const errors = mergePluginErrors(
      arrayValue(currentPlugins.errors),
      snapshot.loadResult.errors.map(pluginErrorFromIssue),
    );
    return {
      ...current,
      plugins: {
        ...currentPlugins,
        enabled: snapshot.loadResult.enabled.map(appStatePlugin),
        disabled: snapshot.loadResult.disabled.map(appStatePlugin),
        commands: [...snapshot.commands, ...snapshot.skills],
        outputStyles: snapshot.outputStyles.map((style) => style.name),
        errors,
        needsRefresh: false,
      },
      agentDefinitions: mergeAgentDefinitions(current, snapshot.agents, workspace),
      mcp: {
        ...currentMcp,
        pluginReconnectKey: currentReconnectKey + 1,
      },
    };
  });
}

function currentConfig(ctx: SlashCommandContext): AgenCConfig | undefined {
  return ctx.configStore?.current?.() ?? ctx.session.services.configStore?.current?.();
}

function pluginRuntimeOptionsFromContext(
  ctx: SlashCommandContext,
): PluginRuntimeLoadOptions {
  const config = currentConfig(ctx);
  const workspace = ctx.session.roleWorkspace;
  return {
    cwd: workspace.cwd,
    workspaceRoot: workspace.cwd,
    agencHome: ctx.agencHome ?? join(ctx.home, ".agenc"),
    ...(config !== undefined ? { config } : {}),
  };
}

export async function refreshActivePlugins(
  ctx: SlashCommandContext,
): Promise<PluginRegistrationSnapshot> {
  const workspace = ctx.session.roleWorkspace;
  if (ctx.appState !== undefined) {
    const liveState = ctx.appState.getAppState?.();
    if (!isRecord(liveState) || !isRecord(liveState.agentDefinitions)) {
      throw new Error(
        "Cannot refresh plugins: live agent catalog provenance is unavailable",
      );
    }
    assertAgentRoleWorkspaceMatches(
      workspace,
      agentRoleWorkspaceEnvelopeId(liveState.agentDefinitions),
    );
  }
  const options = pluginRuntimeOptionsFromContext(ctx);
  const snapshot = await refreshPluginRegistrations(options);
  const activeIdentity = {
    cwd: workspace.cwd,
    ...(options.agencHome !== undefined ? { agencHome: options.agencHome } : {}),
  };
  setActivePluginCommandSnapshot(activeIdentity, snapshot.commands);
  setActivePluginSkillSnapshot(activeIdentity, snapshot.skills);
  setActivePluginAgentSnapshot(
    { ...options, cwd: workspace.cwd },
    snapshot.agents,
  );
  registerPluginHooksWithRuntime(ctx, snapshot.hooks);
  updatePluginAppState(ctx.appState?.setAppState, snapshot, workspace);
  return snapshot;
}

function mergeHookMaps(
  base: HooksMap | undefined,
  pluginHooks: HooksMap | undefined,
): HooksMap | undefined {
  if (!base) return pluginHooks;
  if (!pluginHooks) return base;
  const out: Record<string, NonNullable<HooksMap[string]>> = {};
  for (const [event, matchers] of Object.entries(base)) {
    out[event] = [...matchers];
  }
  for (const [event, matchers] of Object.entries(pluginHooks)) {
    out[event] = [...(out[event] ?? []), ...matchers];
  }
  return out;
}

function registerPluginHooksWithRuntime(
  ctx: SlashCommandContext,
  hooks: HooksMap | undefined,
): void {
  const runtime = ctx.session.services.hooksRuntime;
  if (!runtime) return;
  runtime.load(mergeHookMaps(currentConfig(ctx)?.hooks, hooks));
}

export function clearPluginRegistrationCaches(): void {
  clearRuntimePluginLoadCache();
  clearPluginCommandCache();
  clearPluginSkillsCache();
  clearPluginAgentCache();
  clearPluginHookCache();
  clearPluginMcpServerCache();
  clearPluginLspServerCache();
  clearPluginOutputStyleCache();
}
