/**
 * Public presentation and aliasing for agent roles.
 *
 * Internal role ids stay stable for compatibility with existing metadata,
 * permissions, and restored sessions. Model/TUI copy can use the cyberpunk
 * labels exposed here without rewriting the runtime role contract.
 *
 * @module
 */

export interface AgentRolePresentation {
  readonly canonicalName: string;
  readonly publicName: string;
  readonly label: string;
  readonly aliases: readonly string[];
}

const ROLE_PRESENTATION: Readonly<Record<string, AgentRolePresentation>> = {
  default: {
    canonicalName: "default",
    publicName: "netrunner",
    label: "Netrunner",
    aliases: ["default", "netrunner"],
  },
  explorer: {
    canonicalName: "explorer",
    publicName: "scanner",
    label: "Scanner",
    aliases: ["explorer", "explore", "research", "researcher", "scanner"],
  },
  worker: {
    canonicalName: "worker",
    publicName: "runner",
    label: "Runner",
    aliases: ["worker", "coding", "implement", "implementation", "runner"],
  },
  docs: {
    canonicalName: "docs",
    publicName: "scribe",
    label: "Scribe",
    aliases: ["docs", "documentation", "scribe"],
  },
  operator: {
    canonicalName: "operator",
    publicName: "fixer",
    label: "Fixer",
    aliases: ["operator", "fixer"],
  },
  marketplace: {
    canonicalName: "marketplace",
    publicName: "broker",
    label: "Broker",
    aliases: ["marketplace", "market", "broker"],
  },
  browser: {
    canonicalName: "browser",
    publicName: "ghost",
    label: "Ghost",
    aliases: ["browser", "browser-test", "browser-testing", "ghost"],
  },
  remote: {
    canonicalName: "remote",
    publicName: "trace",
    label: "Trace",
    aliases: ["remote", "remote-debug", "remote-debugging", "trace"],
  },
};

const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const presentation of Object.values(ROLE_PRESENTATION)) {
  for (const alias of presentation.aliases) {
    ALIAS_TO_CANONICAL.set(normalizeRoleKey(alias), presentation.canonicalName);
  }
}

function normalizeRoleKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^project:/, "")
    .replace(/^user:/, "")
    .replace(/[_\s]+/gu, "-");
}

export function canonicalAgentRoleName(roleName: string): string {
  const normalized = normalizeRoleKey(roleName);
  return ALIAS_TO_CANONICAL.get(normalized) ?? normalized;
}

export function agentRolePresentation(
  roleName: string | undefined,
): AgentRolePresentation | undefined {
  if (!roleName) return undefined;
  const canonicalName = canonicalAgentRoleName(roleName);
  return ROLE_PRESENTATION[canonicalName];
}

export function agentRoleDisplayLabel(roleName: string | undefined): string | undefined {
  return agentRolePresentation(roleName)?.label;
}

export function agentRolePublicName(roleName: string | undefined): string | undefined {
  return agentRolePresentation(roleName)?.publicName;
}

export function formatAgentRoleLabel(roleName: string | undefined, fallback = "Agent"): string {
  if (!roleName) return fallback;
  return agentRoleDisplayLabel(roleName) ?? roleName;
}

export function formatAgentRolePublicName(roleName: string | undefined): string | undefined {
  return agentRolePublicName(roleName) ?? roleName;
}
