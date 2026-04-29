export interface AgentRolePresentation {
  readonly label: string;
  readonly description?: string;
}

const ROLE_PRESENTATION_BY_ID: Readonly<Record<string, AgentRolePresentation>> = {
  coding: {
    label: "Runner",
    description: "Bounded implementation child for repo-local code changes.",
  },
  implement: {
    label: "Runner",
  },
  worker: {
    label: "Runner",
  },
  docs: {
    label: "Scribe",
    description: "Documentation and examples child for concise user-facing edits.",
  },
  documentation: {
    label: "Scribe",
  },
  research: {
    label: "Scanner",
    description: "Read-only evidence-gathering child for source-backed inspection.",
  },
  explore: {
    label: "Scanner",
  },
  explorer: {
    label: "Scanner",
  },
  verify: {
    label: "Sentinel",
    description: "Verifier child that tries to disprove an implementation with concrete checks.",
  },
  verification: {
    label: "Sentinel",
  },
  verifier: {
    label: "Sentinel",
  },
  review: {
    label: "Sentinel",
  },
  reviewer: {
    label: "Sentinel",
  },
  operator: {
    label: "Fixer",
    description: "Runtime operations child for daemon, approvals, MCP, plugin, and session workflows.",
  },
  marketplace: {
    label: "Broker",
    description: "Marketplace child for protocol task, skill, reputation, and governance surfaces.",
  },
  market: {
    label: "Broker",
  },
  "browser-testing": {
    label: "Ghost",
    description: "Browser-grounded QA child for UI and flow validation.",
  },
  "browser-test": {
    label: "Ghost",
  },
  browser: {
    label: "Ghost",
  },
  "remote-debugging": {
    label: "Trace",
    description: "Remote session and job debugging child for bounded operational diagnosis.",
  },
  "remote-debug": {
    label: "Trace",
  },
  remote: {
    label: "Trace",
  },
};

function normalizeRoleKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^project:/, "")
    .replace(/^user:/, "")
    .replace(/[_\s]+/gu, "-");
}

export function resolveAgentRolePresentation(
  roleId: string | undefined,
): AgentRolePresentation | undefined {
  if (!roleId) return undefined;
  const key = normalizeRoleKey(roleId);
  return ROLE_PRESENTATION_BY_ID[key];
}

export function resolveAgentRoleDisplayName(
  roleId: string | undefined,
  fallback: string,
): string {
  return resolveAgentRolePresentation(roleId)?.label ?? fallback;
}
