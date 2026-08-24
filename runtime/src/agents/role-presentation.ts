/**
 * Public presentation and aliasing for agent roles.
 *
 * Built-in registry ids and public names share one canonical spelling.
 * Presentation metadata only supplies display labels and intentional semantic
 * shortcuts; retired built-in ids are not aliases.
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
    aliases: ["default", "netrunner", "general-purpose"],
  },
  scanner: {
    canonicalName: "scanner",
    publicName: "scanner",
    label: "Scanner",
    aliases: ["explore", "research", "researcher", "scanner"],
  },
  runner: {
    canonicalName: "runner",
    publicName: "runner",
    label: "Runner",
    aliases: ["coding", "implement", "implementation", "runner"],
  },
  Plan: {
    canonicalName: "Plan",
    publicName: "Plan",
    label: "Plan",
    // `plan` is required: spawn lowercases the requested name before registry
    // lookup, so the lowercased form must alias back to the capital `Plan` key.
    aliases: ["plan"],
  },
  verification: {
    canonicalName: "verification",
    publicName: "verification",
    label: "Verification",
    aliases: ["verification"],
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

function agentRoleDisplayLabel(roleName: string | undefined): string | undefined {
  return agentRolePresentation(roleName)?.label;
}

function agentRolePublicName(roleName: string | undefined): string | undefined {
  return agentRolePresentation(roleName)?.publicName;
}

export function formatAgentRoleLabel(roleName: string | undefined, fallback = "Agent"): string {
  if (!roleName) return fallback;
  return agentRoleDisplayLabel(roleName) ?? roleName;
}

export function formatAgentRolePublicName(roleName: string | undefined): string | undefined {
  return agentRolePublicName(roleName) ?? roleName;
}
