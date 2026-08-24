import type { ConfigStore } from "../../config/store.js";
import type { AgenCConfig } from "../../config/schema.js";
import type { PermissionRuleSource } from "../types.js";
import { isTrustRecord } from "./records.js";

export interface ProjectTrustSourceSummary {
  readonly source: "projectSettings" | "localSettings";
  readonly label: string;
  readonly details: readonly string[];
}

export interface ProjectTrustSourceOptions {
  readonly cwd: string;
  readonly configStore?: ConfigStore;
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
  return source === "projectSettings" ? "Project config" : "Local config";
}

function stringKeys(value: unknown): string[] {
  if (!isTrustRecord(value)) return [];
  return Object.keys(value).filter((key) => key.length > 0).sort();
}

function isSafeEnvKey(key: string): boolean {
  return SAFE_ENV_KEYS.has(key) || key.startsWith("LC_");
}

function collectHookDetails(json: AgenCConfig): string[] {
  const hooks = json.hooks;
  if (!isTrustRecord(hooks)) return [];
  const names = stringKeys(hooks);
  return names.length > 0
    ? [`ignored capability hook declarations: ${names.join(", ")}`]
    : [];
}

function collectMcpServerDetails(json: AgenCConfig): string[] {
  const servers = isTrustRecord(json.mcp_servers)
    ? json.mcp_servers
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
    details.push(
      `MCP declarations requiring separate digest approval: ${serverNames.join(", ")}`,
    );
  }
  if (envKeys.size > 0) {
    details.push(`non-authoritative MCP env keys: ${[...envKeys].sort().join(", ")}`);
  }
  return details;
}

function collectShellEnvDetails(json: AgenCConfig): string[] {
  const policy = isTrustRecord(json.shell_environment_policy)
    ? json.shell_environment_policy
    : null;
  if (policy === null || !isTrustRecord(policy.set)) return [];
  const keys = Object.keys(policy.set).filter((key) => !isSafeEnvKey(key)).sort();
  return keys.length > 0
    ? [`ignored shell environment grants: ${keys.join(", ")}`]
    : [];
}

function summarizeSettings(
  source: "projectSettings" | "localSettings",
  json: AgenCConfig | null,
): ProjectTrustSourceSummary | null {
  if (json === null) return null;
  const details = [
    ...collectHookDetails(json),
    ...collectMcpServerDetails(json),
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
  const store = options.configStore;
  if (!store) return [];
  const summaries: ProjectTrustSourceSummary[] = [];
  for (const source of PROJECT_SOURCES) {
    const scope = source === "projectSettings" ? "project" : "local";
    const details = new Set<string>();
    for (const ignored of store.ignored()) {
      if (ignored.scope !== scope) continue;
      if (ignored.key === "permissions.allow") {
        details.add("ignored capability allow rule declarations");
      } else if (ignored.key === "permissions.defaultMode") {
        details.add("ignored permission default declaration");
      } else if (ignored.key === "shell_environment_policy.set") {
        details.add("ignored shell environment grants");
      }
    }
    for (const layer of store.sources(scope)) {
      const summary = summarizeSettings(
        source,
        layer.config,
      );
      for (const detail of summary?.details ?? []) details.add(detail);
    }
    if (details.size > 0) {
      summaries.push({ source, label: sourceLabel(source), details: [...details] });
    }
  }
  return summaries;
}

export function formatProjectTrustSources(
  summaries: readonly ProjectTrustSourceSummary[],
): readonly string[] {
  return summaries.flatMap((summary) =>
    summary.details.map(
      (detail) =>
        `${summary.label} (non-authoritative; path trust does not activate grants): ${detail}`,
    ),
  );
}
