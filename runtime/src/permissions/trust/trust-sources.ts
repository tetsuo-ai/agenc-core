import type { ConfigStore } from "../../config/store.js";
import {
  getSettingsFilePathForSource,
  readSettingsFileLenient,
  settingsJsonToRules,
  type DiskEnv,
  type SettingsJson,
} from "../settings.js";
import type { PermissionRuleSource } from "../types.js";
import { isTrustRecord } from "./records.js";

export interface ProjectTrustSourceSummary {
  readonly source: "projectSettings" | "localSettings";
  readonly label: string;
  readonly details: readonly string[];
}

export interface ProjectTrustSourceOptions {
  readonly cwd: string;
  readonly home?: string;
  readonly configStore?: ConfigStore;
  readonly flagSettingsPath?: string;
  readonly managedSettingsPath?: string;
}

const PROJECT_SOURCES = ["projectSettings", "localSettings"] as const;

const SAFE_ENV_KEYS = new Set([
  "COLORTERM",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]);

function sourceLabel(source: PermissionRuleSource): string {
  return source === "projectSettings" ? "Project settings" : "Local settings";
}

function stringKeys(value: unknown): string[] {
  if (!isTrustRecord(value)) return [];
  return Object.keys(value).filter((key) => key.length > 0).sort();
}

function isSafeEnvKey(key: string): boolean {
  return SAFE_ENV_KEYS.has(key) || key.startsWith("LC_");
}

function collectHookDetails(json: SettingsJson): string[] {
  const hooks = json.hooks;
  if (!isTrustRecord(hooks)) return [];
  const names = stringKeys(hooks);
  return names.length > 0 ? [`hooks: ${names.join(", ")}`] : [];
}

function collectMcpServerDetails(json: SettingsJson): string[] {
  const servers = isTrustRecord(json.mcp_servers)
    ? json.mcp_servers
    : isTrustRecord(json.mcpServers)
      ? json.mcpServers
      : null;
  if (servers === null) return [];
  const serverNames = Object.entries(servers)
    .filter(([, server]) => !isTrustRecord(server) || server.enabled !== false)
    .map(([name]) => name)
    .sort();
  const envKeys = new Set<string>();
  for (const server of Object.values(servers)) {
    if (!isTrustRecord(server) || !isTrustRecord(server.env)) continue;
    for (const key of Object.keys(server.env)) {
      if (!isSafeEnvKey(key)) envKeys.add(key);
    }
  }
  const details: string[] = [];
  if (serverNames.length > 0) {
    details.push(`MCP servers: ${serverNames.join(", ")}`);
  }
  if (envKeys.size > 0) {
    details.push(`MCP env keys: ${[...envKeys].sort().join(", ")}`);
  }
  return details;
}

function collectPermissionDetails(
  json: SettingsJson,
  source: "projectSettings" | "localSettings",
): string[] {
  const details: string[] = [];
  const allowRules = settingsJsonToRules(json, source)
    .filter((rule) => rule.ruleBehavior === "allow")
    .map((rule) => rule.ruleValue.toolName)
    .filter((tool, index, tools) => tools.indexOf(tool) === index)
    .sort();
  if (allowRules.length > 0) {
    details.push(`allow rules: ${allowRules.join(", ")}`);
  }
  const defaultMode =
    json.permissions?.defaultMode ?? json.permissions?.default_mode;
  if (
    defaultMode === "bypassPermissions" ||
    defaultMode === "acceptEdits" ||
    defaultMode === "auto"
  ) {
    details.push(`permission default: ${defaultMode}`);
  }
  return details;
}

function collectShellEnvDetails(json: SettingsJson): string[] {
  const policy = isTrustRecord(json.shell_environment_policy)
    ? json.shell_environment_policy
    : isTrustRecord(json.shellEnvironmentPolicy)
      ? json.shellEnvironmentPolicy
      : null;
  if (policy === null || !isTrustRecord(policy.set)) return [];
  const keys = Object.keys(policy.set).filter((key) => !isSafeEnvKey(key)).sort();
  return keys.length > 0 ? [`shell env keys: ${keys.join(", ")}`] : [];
}

function summarizeSettings(
  source: "projectSettings" | "localSettings",
  json: SettingsJson | null,
): ProjectTrustSourceSummary | null {
  if (json === null) return null;
  const details = [
    ...collectHookDetails(json),
    ...collectMcpServerDetails(json),
    ...collectPermissionDetails(json, source),
    ...collectShellEnvDetails(json),
  ];
  if (details.length === 0) return null;
  return {
    source,
    label: sourceLabel(source),
    details,
  };
}

export async function summarizeProjectTrustSources(
  options: ProjectTrustSourceOptions,
): Promise<readonly ProjectTrustSourceSummary[]> {
  const env: DiskEnv = {
    cwd: options.cwd,
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.configStore !== undefined ? { configStore: options.configStore } : {}),
    ...(options.flagSettingsPath !== undefined
      ? { flagSettingsPath: options.flagSettingsPath }
      : {}),
    ...(options.managedSettingsPath !== undefined
      ? { managedSettingsPath: options.managedSettingsPath }
      : {}),
  };
  const summaries: ProjectTrustSourceSummary[] = [];
  for (const source of PROJECT_SOURCES) {
    const path = getSettingsFilePathForSource(source, env);
    if (path === null) continue;
    const summary = summarizeSettings(source, await readSettingsFileLenient(path));
    if (summary !== null) summaries.push(summary);
  }
  return summaries;
}

export function formatProjectTrustSources(
  summaries: readonly ProjectTrustSourceSummary[],
): readonly string[] {
  return summaries.flatMap((summary) =>
    summary.details.map((detail) => `${summary.label}: ${detail}`),
  );
}
