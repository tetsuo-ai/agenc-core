import { detectSolanaKeypair, generateDefaultConfig } from "../cli/wizard.js";
import { defaultDesktopSandboxConfig } from "../desktop/types.js";
import {
  WORKSPACE_FILES,
  getDefaultWorkspacePath,
  type WorkspaceFileName,
} from "../gateway/workspace-files.js";
import type { GatewayConfig } from "../gateway/types.js";
import { DEFAULT_GROK_MODEL } from "../gateway/llm-provider-manager.js";
import type {
  GeneratedOnboardingProfile,
  OnboardingAnswers,
} from "./types.js";

const DEFAULT_MISSION =
  "Operate as a capable local agent that can reason clearly, use tools, and help me execute real work without drama.";
const DEFAULT_ROLE = "General-purpose operator";
const DEFAULT_TRAITS = ["direct", "disciplined", "strategic"];
const DEFAULT_RULES = [
  "Prefer action over narration.",
  "State uncertainty plainly when facts are unclear.",
  "Protect user data and ask before destructive changes.",
];
const DEFAULT_MEMORY = [
  "This agent runs inside AgenC and should treat the local workspace as operator-owned.",
];

function cleanText(value: string | undefined, fallback = ""): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : fallback;
}

function cleanList(
  values: readonly string[] | undefined,
  fallback: readonly string[],
): string[] {
  const normalized = (values ?? [])
    .map((value) => value.trim())
    .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
  return normalized.length > 0 ? normalized : [...fallback];
}

function readLegacyMarketplaceEnabled(
  config: GatewayConfig | undefined,
): boolean | undefined {
  const legacyConfig = config as (GatewayConfig & {
    marketplace?: { enabled?: boolean };
  }) | undefined;
  return typeof legacyConfig?.marketplace?.enabled === "boolean"
    ? legacyConfig.marketplace.enabled
    : undefined;
}

function describeToolPosture(posture: OnboardingAnswers["toolPosture"]): string {
  switch (posture) {
    case "guarded":
      return "Use tools narrowly. Prefer asking before tool-heavy or system-changing actions.";
    case "broad":
      return "Use tools aggressively when they materially speed up execution, while still respecting policy.";
    case "balanced":
    default:
      return "Use tools when they unlock execution, but narrate intent clearly before risky moves.";
  }
}

function describeAutonomy(posture: OnboardingAnswers["autonomy"]): string {
  switch (posture) {
    case "conservative":
      return "Default to confirmation before risky, expensive, or irreversible actions.";
    case "aggressive":
      return "Bias toward self-starting execution and only pause for real risk boundaries.";
    case "balanced":
    default:
      return "Act decisively on low-risk work and escalate when the blast radius is meaningful.";
  }
}

function describeVerbosity(verbosity: OnboardingAnswers["verbosity"]): string {
  switch (verbosity) {
    case "tight":
      return "Keep responses compact and high-signal by default.";
    case "detailed":
      return "Give fuller reasoning and context when it helps the operator move faster.";
    case "balanced":
    default:
      return "Prefer concise answers, but expand when the task actually needs it.";
  }
}

function withBulletList(
  title: string,
  values: readonly string[],
  emptyFallback: string,
): string {
  const lines = values.length > 0 ? values.map((value) => `- ${value}`) : [`- ${emptyFallback}`];
  return [`## ${title}`, ...lines].join("\n");
}

function buildAgentFile(answers: OnboardingAnswers): string {
  return [
    "# Agent Configuration",
    "",
    "This file defines the operating identity of the local AgenC agent.",
    "",
    "## Name",
    answers.agentName,
    "",
    "## Role",
    answers.role,
    "",
    "## Mission",
    answers.mission,
    "",
    withBulletList("Always-Do Rules", answers.alwaysDoRules, "Move the task forward without unnecessary ceremony."),
    "",
  ].join("\n");
}

function buildAgencFile(answers: OnboardingAnswers): string {
  return [
    "# AgenC Workspace Contract",
    "",
    "This workspace is the operator-controlled local contract for this agent.",
    "",
    "## Operating Assumptions",
    `- Primary role: ${answers.role}`,
    `- Marketplace features: ${answers.marketplaceEnabled ? "enabled" : "disabled"}`,
    `- Social features: ${answers.socialEnabled ? "enabled" : "disabled"}`,
    `- Desktop automation: ${answers.desktopAutomationEnabled ? "enabled" : "disabled"}`,
    "",
    "## General Rules",
    "- Treat workspace markdown files as durable operator instructions.",
    "- Keep outputs grounded in actual tool evidence.",
    "- Do not invent completion, progress, or marketplace outcomes.",
    "",
  ].join("\n");
}

function buildSoulFile(answers: OnboardingAnswers): string {
  return [
    "# Soul",
    "",
    "This file captures the voice and temperament of the agent.",
    "",
    withBulletList("Core Traits", answers.soulTraits, "direct"),
    "",
    "## Tone",
    answers.tone,
    "",
    "## Verbosity",
    describeVerbosity(answers.verbosity),
    "",
    "## Autonomy",
    describeAutonomy(answers.autonomy),
    "",
  ].join("\n");
}

function buildUserFile(answers: OnboardingAnswers): string {
  return [
    "# User Preferences",
    "",
    "These are the default interaction preferences for this local operator.",
    "",
    "## Response Style",
    `- Tone alignment: ${answers.tone}`,
    `- Verbosity: ${answers.verbosity}`,
    "- Prioritize clarity, directness, and execution-ready output.",
    "",
  ].join("\n");
}

function buildToolsFile(answers: OnboardingAnswers): string {
  return [
    "# Tool Guidelines",
    "",
    "Tool use should be deliberate and operator-aligned.",
    "",
    "## Tool Posture",
    describeToolPosture(answers.toolPosture),
    "",
    "## Desktop Automation",
    answers.desktopAutomationEnabled
      ? "- Desktop/browser automation is available when it materially helps execution."
      : "- Do not rely on desktop/browser automation by default.",
    "",
    "## Execution Rules",
    "- Use tools to verify claims instead of guessing.",
    "- Prefer the smallest useful action before escalating to heavier automation.",
    "- Summarize the result of tool work in plain language.",
    "",
  ].join("\n");
}

function buildHeartbeatFile(answers: OnboardingAnswers): string {
  const checks = answers.marketplaceEnabled
    ? ["- Refresh marketplace/task visibility when the daemon is healthy."]
    : ["- No autonomous marketplace polling is required by default."];
  return [
    "# Heartbeat",
    "",
    "Periodic posture for the local agent runtime.",
    "",
    ...checks,
    "- Confirm wallet and RPC health before high-value actions.",
    "- Keep local state tidy and avoid noisy loops.",
    "",
  ].join("\n");
}

function buildBootFile(answers: OnboardingAnswers): string {
  return [
    "# Boot",
    "",
    "Startup checklist executed when the agent comes online.",
    "",
    "- Load the canonical AgenC config and workspace files.",
    "- Verify xAI access, wallet path, and RPC connectivity.",
    `- Assume the agent is operating as: ${answers.role}.`,
    answers.marketplaceEnabled
      ? "- Enable marketplace-aware posture after core health checks pass."
      : "- Keep marketplace-specific behavior disabled unless explicitly enabled later.",
    "",
  ].join("\n");
}

function buildIdentityFile(answers: OnboardingAnswers): string {
  return [
    "# Identity",
    "",
    "Durable identity hints for the local agent.",
    "",
    "## Primary",
    `- Agent name: ${answers.agentName}`,
    `- Role: ${answers.role}`,
    `- Wallet path: ${answers.walletPath ?? "not configured yet"}`,
    "",
  ].join("\n");
}

function buildMemoryFile(answers: OnboardingAnswers): string {
  return [
    "# Memory",
    "",
    "Stable facts the agent should keep in mind across sessions.",
    "",
    ...cleanList(answers.memorySeeds, DEFAULT_MEMORY).map((value) => `- ${value}`),
    "",
  ].join("\n");
}

function buildCapabilitiesFile(answers: OnboardingAnswers): string {
  return [
    "# Capabilities",
    "",
    "High-level behavioral capability map for this local agent.",
    "",
    `- Core operating mode: ${answers.role}`,
    "- Tool execution and verification",
    answers.marketplaceEnabled
      ? "- Marketplace discovery and task participation"
      : "- Marketplace flows disabled until explicitly enabled",
    answers.desktopAutomationEnabled
      ? "- Local desktop/browser automation"
      : "- No desktop/browser automation by default",
    "",
  ].join("\n");
}

function buildPolicyFile(answers: OnboardingAnswers): string {
  return [
    "# Policy",
    "",
    "Operator-facing safety and execution boundaries.",
    "",
    "## Autonomy",
    describeAutonomy(answers.autonomy),
    "",
    "## Non-Negotiables",
    "- Never claim a result that was not actually observed.",
    "- Ask before destructive filesystem, wallet, or irreversible marketplace actions.",
    "- Keep secrets out of markdown and normal user-facing output.",
    "",
  ].join("\n");
}

function buildReputationFile(answers: OnboardingAnswers): string {
  return [
    "# Reputation",
    "",
    "Reputation posture for marketplace-facing behavior.",
    "",
    answers.marketplaceEnabled
      ? "- Favor reliable execution, honest status reporting, and conservative claims."
      : "- Marketplace reputation is inactive until marketplace mode is enabled.",
    "- Do not chase reputation with spammy or low-signal behavior.",
    "",
  ].join("\n");
}

function buildXFile(answers: OnboardingAnswers): string {
  return [
    "# X",
    "",
    "Public posting posture for this agent.",
    "",
    answers.socialEnabled
      ? "- If posting publicly, stay useful, restrained, and evidence-backed."
      : "- Public posting is disabled by default.",
    "- No manufactured hype or false certainty.",
    "",
  ].join("\n");
}

export function createDefaultOnboardingAnswers(
  existingConfig?: GatewayConfig,
): OnboardingAnswers {
  const walletPath =
    cleanText(existingConfig?.connection?.keypairPath) || detectSolanaKeypair();
  return {
    apiKey: cleanText(existingConfig?.llm?.apiKey),
    model: cleanText(existingConfig?.llm?.model, DEFAULT_GROK_MODEL),
    agentName: cleanText(existingConfig?.agent?.name, "AgenC"),
    mission: DEFAULT_MISSION,
    role: DEFAULT_ROLE,
    alwaysDoRules: [...DEFAULT_RULES],
    soulTraits: [...DEFAULT_TRAITS],
    tone: "Direct and calm",
    verbosity: "balanced",
    autonomy: "balanced",
    toolPosture: "balanced",
    memorySeeds: [...DEFAULT_MEMORY],
    desktopAutomationEnabled: existingConfig?.desktop?.enabled ?? false,
    walletPath: walletPath ? walletPath : null,
    rpcUrl: cleanText(
      existingConfig?.connection?.rpcUrl,
      "https://api.devnet.solana.com",
    ),
    marketplaceEnabled: readLegacyMarketplaceEnabled(existingConfig) ?? true,
    socialEnabled: existingConfig?.social?.enabled ?? false,
  };
}

export function buildOnboardingProfile(
  answers: OnboardingAnswers,
  baseConfig?: GatewayConfig,
): GeneratedOnboardingProfile {
  const normalizedAnswers: OnboardingAnswers = {
    ...answers,
    apiKey: cleanText(answers.apiKey),
    model: cleanText(answers.model, DEFAULT_GROK_MODEL),
    agentName: cleanText(answers.agentName, "AgenC"),
    mission: cleanText(answers.mission, DEFAULT_MISSION),
    role: cleanText(answers.role, DEFAULT_ROLE),
    alwaysDoRules: cleanList(answers.alwaysDoRules, DEFAULT_RULES),
    soulTraits: cleanList(answers.soulTraits, DEFAULT_TRAITS),
    tone: cleanText(answers.tone, "Direct and calm"),
    memorySeeds: cleanList(answers.memorySeeds, DEFAULT_MEMORY),
    rpcUrl: cleanText(answers.rpcUrl, "https://api.devnet.solana.com"),
    walletPath: cleanText(answers.walletPath ?? undefined) || null,
  };

  const baseSource = baseConfig
    ? structuredClone(baseConfig)
    : generateDefaultConfig();
  const {
    marketplace: _legacyMarketplace,
    ...base
  } = baseSource as GatewayConfig & { marketplace?: unknown };
  const connection = {
    ...base.connection,
    rpcUrl: normalizedAnswers.rpcUrl,
  };
  if (normalizedAnswers.walletPath) {
    connection.keypairPath = normalizedAnswers.walletPath;
  } else {
    delete connection.keypairPath;
  }

  const config: GatewayConfig = {
    ...base,
    agent: {
      ...base.agent,
      name: normalizedAnswers.agentName,
    },
    connection,
    llm: {
      ...(base.llm ?? {}),
      provider: "grok",
      apiKey: normalizedAnswers.apiKey,
      model: normalizedAnswers.model,
    },
    logging: {
      ...(base.logging ?? {}),
      level: base.logging?.level ?? "info",
    },
    desktop: {
      ...(base.desktop ?? defaultDesktopSandboxConfig()),
      enabled: normalizedAnswers.desktopAutomationEnabled,
    },
    social: {
      ...(base.social ?? {}),
      enabled: normalizedAnswers.socialEnabled,
    },
    workspace: {
      ...(base.workspace ?? {}),
      hostPath: getDefaultWorkspacePath(),
    },
  };

  const workspaceFiles: Record<WorkspaceFileName, string> = {
    [WORKSPACE_FILES.AGENC]: buildAgencFile(normalizedAnswers),
    [WORKSPACE_FILES.AGENT]: buildAgentFile(normalizedAnswers),
    [WORKSPACE_FILES.SOUL]: buildSoulFile(normalizedAnswers),
    [WORKSPACE_FILES.USER]: buildUserFile(normalizedAnswers),
    [WORKSPACE_FILES.TOOLS]: buildToolsFile(normalizedAnswers),
    [WORKSPACE_FILES.HEARTBEAT]: buildHeartbeatFile(normalizedAnswers),
    [WORKSPACE_FILES.BOOT]: buildBootFile(normalizedAnswers),
    [WORKSPACE_FILES.IDENTITY]: buildIdentityFile(normalizedAnswers),
    [WORKSPACE_FILES.MEMORY]: buildMemoryFile(normalizedAnswers),
    [WORKSPACE_FILES.CAPABILITIES]: buildCapabilitiesFile(normalizedAnswers),
    [WORKSPACE_FILES.POLICY]: buildPolicyFile(normalizedAnswers),
    [WORKSPACE_FILES.REPUTATION]: buildReputationFile(normalizedAnswers),
    [WORKSPACE_FILES.X]: buildXFile(normalizedAnswers),
  };

  return {
    config,
    workspaceFiles,
  };
}
