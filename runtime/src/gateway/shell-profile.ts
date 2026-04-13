export const SESSION_SHELL_PROFILE_METADATA_KEY = "shellProfile";

export type SessionShellProfile =
  | "general"
  | "coding"
  | "research"
  | "validation"
  | "documentation"
  | "operator";

export const DEFAULT_SESSION_SHELL_PROFILE: SessionShellProfile = "general";

const SESSION_SHELL_PROFILES = [
  "general",
  "coding",
  "research",
  "validation",
  "documentation",
  "operator",
] as const satisfies readonly SessionShellProfile[];

const SESSION_SHELL_PROFILE_SET = new Set<SessionShellProfile>(
  SESSION_SHELL_PROFILES,
);

export interface ShellProfileApprovalHints {
  readonly readOnlyBias: boolean;
  readonly mutatingToolsDeemphasized: boolean;
  readonly policyMode: "inherit";
}

export interface ShellProfileDefinition {
  readonly name: SessionShellProfile;
  readonly label: string;
  readonly promptHeading: string;
  readonly promptRules: readonly string[];
  readonly toolPrefixes: readonly string[];
  readonly exactToolNames?: readonly string[];
  readonly delegationDefault:
    | "balanced"
    | "coding"
    | "research"
    | "verify"
    | "operator";
  readonly approvalHints: ShellProfileApprovalHints;
}

const DEFINITIONS: Record<SessionShellProfile, ShellProfileDefinition> = {
  general: {
    name: "general",
    label: "General",
    promptHeading: "General Shell Defaults",
    promptRules: [
      "Handle mixed operator, coding, research, and workflow requests without assuming one narrow mode.",
      "Prefer direct progress with the current tool surface, but do not over-specialize toward repository work unless the user is clearly doing coding.",
      "Keep delegation, tool choice, and verification proportional to the task.",
    ],
    toolPrefixes: [],
    delegationDefault: "balanced",
    approvalHints: {
      readOnlyBias: false,
      mutatingToolsDeemphasized: false,
      policyMode: "inherit",
    },
  },
  coding: {
    name: "coding",
    label: "Coding",
    promptHeading: "Coding Shell Defaults",
    promptRules: [
      "Treat the local workspace as the primary source of truth and prefer inspect-edit-verify loops over speculative prose.",
      "Bias toward file, shell, test, task, and delegated implementation tools that materially move code work forward.",
      "When changing code, validate behavior with the smallest useful check before concluding.",
    ],
    toolPrefixes: ["task.", "verification."],
    exactToolNames: [
      "system.readFile",
      "system.readFileRange",
      "system.writeFile",
      "system.appendFile",
      "system.editFile",
      "system.listDir",
      "system.stat",
      "system.mkdir",
      "system.move",
      "system.bash",
      "system.grep",
      "system.glob",
      "system.searchFiles",
      "system.repoInventory",
      "system.gitStatus",
      "system.gitDiff",
      "system.gitShow",
      "system.gitBranchInfo",
      "system.gitChangeSummary",
      "system.gitWorktreeList",
      "system.gitWorktreeCreate",
      "system.gitWorktreeRemove",
      "system.gitWorktreeStatus",
      "system.applyPatch",
      "system.symbolSearch",
      "system.symbolDefinition",
      "system.symbolReferences",
      "system.searchTools",
      "execute_with_agent",
      "coordinator",
    ],
    delegationDefault: "coding",
    approvalHints: {
      readOnlyBias: false,
      mutatingToolsDeemphasized: false,
      policyMode: "inherit",
    },
  },
  research: {
    name: "research",
    label: "Research",
    promptHeading: "Research Shell Defaults",
    promptRules: [
      "Prefer evidence-gathering, reading, and source comparison before taking action.",
      "De-emphasize mutating tools unless the user explicitly asks for edits or execution changes.",
      "Use delegation primarily for bounded investigation, synthesis, and source-backed analysis.",
    ],
    toolPrefixes: ["system.browse", "system.http", "playwright.", "browser_", "task."],
    exactToolNames: ["execute_with_agent"],
    delegationDefault: "research",
    approvalHints: {
      readOnlyBias: true,
      mutatingToolsDeemphasized: true,
      policyMode: "inherit",
    },
  },
  validation: {
    name: "validation",
    label: "Validation",
    promptHeading: "Validation Shell Defaults",
    promptRules: [
      "Bias toward reproduction, inspection, verification, and narrow fixes instead of broad refactors.",
      "De-emphasize mutating tools until you have enough evidence to justify the change.",
      "Prefer explicit checks, logs, tests, and run output over intuition.",
    ],
    toolPrefixes: ["system.", "desktop.", "task."],
    exactToolNames: ["execute_with_agent"],
    delegationDefault: "verify",
    approvalHints: {
      readOnlyBias: true,
      mutatingToolsDeemphasized: true,
      policyMode: "inherit",
    },
  },
  documentation: {
    name: "documentation",
    label: "Documentation",
    promptHeading: "Documentation Shell Defaults",
    promptRules: [
      "Bias toward docs, examples, onboarding flows, and concise explanatory edits.",
      "Prefer reading the current code and docs surface before rewriting user-facing guidance.",
      "Keep structure and wording clear, but still verify referenced commands or paths when they matter.",
    ],
    toolPrefixes: ["system.", "task."],
    exactToolNames: ["execute_with_agent"],
    delegationDefault: "coding",
    approvalHints: {
      readOnlyBias: false,
      mutatingToolsDeemphasized: false,
      policyMode: "inherit",
    },
  },
  operator: {
    name: "operator",
    label: "Operator",
    promptHeading: "Operator Shell Defaults",
    promptRules: [
      "Bias toward daemon, session, connector, marketplace, approval, and runtime-control workflows.",
      "Prefer the existing structured runtime surfaces before ad hoc shell orchestration when both can solve the task.",
      "Keep awareness of system state, long-running handles, and operational visibility.",
    ],
    toolPrefixes: ["agenc.", "system.", "social.", "wallet.", "task."],
    exactToolNames: ["execute_with_agent", "coordinator"],
    delegationDefault: "operator",
    approvalHints: {
      readOnlyBias: false,
      mutatingToolsDeemphasized: false,
      policyMode: "inherit",
    },
  },
};

export function listSessionShellProfiles(): readonly SessionShellProfile[] {
  return SESSION_SHELL_PROFILES;
}

export function isSessionShellProfile(
  value: unknown,
): value is SessionShellProfile {
  return (
    typeof value === "string" &&
    SESSION_SHELL_PROFILE_SET.has(value as SessionShellProfile)
  );
}

export function coerceSessionShellProfile(
  value: unknown,
): SessionShellProfile | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isSessionShellProfile(normalized) ? normalized : undefined;
}

export function resolveSessionShellProfile(
  metadata: Record<string, unknown>,
): SessionShellProfile {
  return (
    coerceSessionShellProfile(metadata[SESSION_SHELL_PROFILE_METADATA_KEY]) ??
    DEFAULT_SESSION_SHELL_PROFILE
  );
}

export function ensureSessionShellProfile(
  metadata: Record<string, unknown>,
  preferred?: unknown,
): SessionShellProfile {
  const profile =
    coerceSessionShellProfile(preferred) ?? resolveSessionShellProfile(metadata);
  metadata[SESSION_SHELL_PROFILE_METADATA_KEY] = profile;
  return profile;
}

export function getShellProfileDefinition(
  profile: SessionShellProfile,
): ShellProfileDefinition {
  return DEFINITIONS[profile];
}

export function getShellProfileApprovalHints(
  profile: SessionShellProfile,
): ShellProfileApprovalHints {
  return getShellProfileDefinition(profile).approvalHints;
}

export function buildShellProfileApprovalContext(
  profile: SessionShellProfile,
): string | undefined {
  if (profile === "general") {
    return undefined;
  }
  const definition = getShellProfileDefinition(profile);
  const hints = definition.approvalHints;
  const posture: string[] = [];
  if (hints.readOnlyBias) {
    posture.push("read-only bias");
  }
  if (hints.mutatingToolsDeemphasized) {
    posture.push("mutating tools de-emphasized until justified");
  }
  const suffix =
    posture.length > 0 ? ` (${posture.join("; ")})` : "";
  return `Active shell profile: ${definition.label}${suffix}.`;
}

export function getShellProfilePreferredToolNames(params: {
  profile: SessionShellProfile;
  availableToolNames: readonly string[];
}): readonly string[] {
  const definition = getShellProfileDefinition(params.profile);
  if (definition.name === "general") {
    return params.availableToolNames;
  }

  const matches = params.availableToolNames.filter((toolName) => {
    if (definition.exactToolNames?.includes(toolName)) {
      return true;
    }
    return definition.toolPrefixes.some((prefix) => toolName.startsWith(prefix));
  });
  return matches.length > 0 ? matches : params.availableToolNames;
}

export function buildShellProfilePromptSection(
  profile: SessionShellProfile,
): string {
  const definition = getShellProfileDefinition(profile);
  return [
    `## ${definition.promptHeading}`,
    ...definition.promptRules.map((rule) => `- ${rule}`),
  ].join("\n");
}

export function appendShellProfilePromptSection(params: {
  systemPrompt: string;
  profile: SessionShellProfile;
}): string {
  const section = buildShellProfilePromptSection(params.profile).trim();
  if (!section) return params.systemPrompt;
  const base = params.systemPrompt.trimEnd();
  return base.length > 0 ? `${base}\n\n${section}` : section;
}
