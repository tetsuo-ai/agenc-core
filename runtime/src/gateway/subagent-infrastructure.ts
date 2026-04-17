/**
 * Sub-agent infrastructure configuration, lifecycle, and delegation helpers.
 *
 * Extracted from daemon.ts — contains standalone types, constants, and functions
 * that back the DaemonManager's sub-agent infrastructure methods.
 *
 * @module
 */

import {
  SessionIsolationManager,
} from "./session-isolation.js";
import {
  SubAgentManager,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
} from "./sub-agent.js";
import {
  DelegationPolicyEngine,
  DelegationVerifierService,
  SubAgentLifecycleEmitter,
} from "./delegation-runtime.js";
import {
  InMemoryDelegationTrajectorySink,
} from "../llm/delegation-learning.js";
import type { LLMProvider } from "../llm/types.js";
import type { Tool } from "../tools/types.js";
import { WorkspaceManager, WorkspaceValidationError } from "./workspace.js";
import {
  filterNamedToolsByEnvironment,
  type ToolEnvironmentMode,
} from "./tool-environment-policy.js";
import { TOOL_DEFINITIONS as DESKTOP_TOOL_DEFINITIONS } from "@tetsuo-ai/desktop-tool-contracts";
import type { GatewayLLMConfig } from "./types.js";
import { toErrorMessage } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";
import {
  hasRuntimeLimit,
  normalizeRuntimeLimit,
} from "../llm/runtime-limit-policy.js";

// ============================================================================
// Types
// ============================================================================

export type DelegationAggressivenessProfile =
  | "conservative"
  | "balanced"
  | "aggressive"
  | "adaptive";

export type SubagentChildProviderStrategy =
  | "same_as_parent"
  | "capability_matched";

export type DelegationHardBlockedTaskClass =
  | "wallet_signing"
  | "wallet_transfer"
  | "stake_or_rewards"
  | "destructive_host_mutation"
  | "credential_exfiltration";

export interface ResolvedSubAgentRuntimeConfig {
  readonly enabled: boolean;
  readonly unsafeBenchmarkMode: boolean;
  readonly mode: "manager_tools" | "handoff" | "hybrid";
  readonly delegationAggressiveness: DelegationAggressivenessProfile;
  readonly maxConcurrent: number;
  readonly maxDepth: number;
  readonly maxFanoutPerTurn: number;
  readonly maxTotalSubagentsPerRequest: number;
  readonly maxCumulativeToolCallsPerRequestTree: number;
  readonly maxCumulativeTokensPerRequestTree: number;
  readonly maxCumulativeTokensPerRequestTreeExplicitlyConfigured: boolean;
  readonly defaultTimeoutMs: number;
  readonly baseSpawnDecisionThreshold: number;
  readonly spawnDecisionThreshold: number;
  readonly handoffMinPlannerConfidence: number;
  readonly forceVerifier: boolean;
  readonly allowParallelSubtasks: boolean;
  readonly hardBlockedTaskClasses: readonly DelegationHardBlockedTaskClass[];
  readonly allowedParentTools?: readonly string[];
  readonly forbiddenParentTools?: readonly string[];
  readonly childToolAllowlistStrategy: "inherit_intersection" | "explicit_only";
  readonly childProviderStrategy: SubagentChildProviderStrategy;
  readonly fallbackBehavior: "continue_without_delegation" | "fail_request";
}

// ============================================================================
// Constants
// ============================================================================

export const SUBAGENT_CONFIG_HARD_CAPS = {
  maxConcurrent: 64,
  maxDepth: 16,
  maxFanoutPerTurn: 64,
  maxTotalSubagentsPerRequest: 1024,
  maxCumulativeToolCallsPerRequestTree: 4096,
  maxCumulativeTokensPerRequestTree: 10_000_000,
  defaultTimeoutMs: 3_600_000,
} as const;

export const DELEGATION_AGGRESSIVENESS_THRESHOLD_OFFSETS: Readonly<
  Record<DelegationAggressivenessProfile, number>
> = {
  conservative: 0.12,
  balanced: 0,
  aggressive: -0.12,
  adaptive: 0,
};

export const DEFAULT_HANDOFF_MIN_PLANNER_CONFIDENCE = 0.82;

export const DEFAULT_HARD_BLOCKED_TASK_CLASSES: readonly DelegationHardBlockedTaskClass[] =
  [
    "wallet_signing",
    "wallet_transfer",
    "stake_or_rewards",
    "credential_exfiltration",
  ];

export const STATIC_SUBAGENT_DESKTOP_TOOLS: readonly Tool[] =
  DESKTOP_TOOL_DEFINITIONS.filter(
    (definition) => definition.name !== "screenshot",
  ).map((definition) => {
    const fullName = `desktop.${definition.name}`;
    return {
      name: fullName,
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async () => ({
        content: JSON.stringify({
          error: `Tool "${fullName}" requires desktop routing context`,
        }),
        isError: true,
      }),
    } satisfies Tool;
  });

// ============================================================================
// Standalone helper functions
// ============================================================================

export function applyDelegationAggressiveness(
  baseThreshold: number,
  profile: DelegationAggressivenessProfile,
): number {
  const offset = DELEGATION_AGGRESSIVENESS_THRESHOLD_OFFSETS[profile] ?? 0;
  return Math.min(1, Math.max(0, baseThreshold + offset));
}

export function resolveSubAgentRuntimeConfig(
  llmConfig: GatewayLLMConfig | undefined,
  options?: {
    readonly unsafeBenchmarkMode?: boolean;
  },
): ResolvedSubAgentRuntimeConfig {
  const subagents = llmConfig?.subagents;
  const unsafeBenchmarkMode = options?.unsafeBenchmarkMode === true;
  const maxCumulativeTokensPerRequestTreeExplicitlyConfigured =
    typeof subagents?.maxCumulativeTokensPerRequestTree === "number";
  const delegationAggressiveness =
    subagents?.delegationAggressiveness === "conservative" ||
    subagents?.delegationAggressiveness === "aggressive" ||
    subagents?.delegationAggressiveness === "adaptive"
      ? subagents.delegationAggressiveness
      : "balanced";
  const baseSpawnDecisionThreshold = Math.min(
    1,
    Math.max(0, subagents?.spawnDecisionThreshold ?? 0.2),
  );
  const normalizeCappedLimit = (
    value: number | undefined,
    fallback: number,
    hardCap: number,
  ): number => {
    const normalized = normalizeRuntimeLimit(value, fallback);
    return hasRuntimeLimit(normalized)
      ? Math.min(hardCap, normalized)
      : hardCap;
  };
  return {
    enabled: subagents?.enabled !== false,
    unsafeBenchmarkMode,
    mode: subagents?.mode ?? "manager_tools",
    delegationAggressiveness,
    maxConcurrent: normalizeCappedLimit(
      subagents?.maxConcurrent,
      MAX_CONCURRENT_SUB_AGENTS,
      SUBAGENT_CONFIG_HARD_CAPS.maxConcurrent,
    ),
    maxDepth: normalizeCappedLimit(
      subagents?.maxDepth,
      4,
      SUBAGENT_CONFIG_HARD_CAPS.maxDepth,
    ),
    maxFanoutPerTurn: normalizeCappedLimit(
      subagents?.maxFanoutPerTurn,
      8,
      SUBAGENT_CONFIG_HARD_CAPS.maxFanoutPerTurn,
    ),
    maxTotalSubagentsPerRequest: normalizeCappedLimit(
      subagents?.maxTotalSubagentsPerRequest,
      32,
      SUBAGENT_CONFIG_HARD_CAPS.maxTotalSubagentsPerRequest,
    ),
    maxCumulativeToolCallsPerRequestTree: normalizeCappedLimit(
      subagents?.maxCumulativeToolCallsPerRequestTree,
      256,
      SUBAGENT_CONFIG_HARD_CAPS.maxCumulativeToolCallsPerRequestTree,
    ),
    maxCumulativeTokensPerRequestTree: normalizeCappedLimit(
      subagents?.maxCumulativeTokensPerRequestTree,
      0,
      SUBAGENT_CONFIG_HARD_CAPS.maxCumulativeTokensPerRequestTree,
    ),
    maxCumulativeTokensPerRequestTreeExplicitlyConfigured,
    defaultTimeoutMs: normalizeCappedLimit(
      subagents?.defaultTimeoutMs,
      DEFAULT_SUB_AGENT_TIMEOUT_MS,
      SUBAGENT_CONFIG_HARD_CAPS.defaultTimeoutMs,
    ),
    baseSpawnDecisionThreshold,
    spawnDecisionThreshold: applyDelegationAggressiveness(
      baseSpawnDecisionThreshold,
      delegationAggressiveness,
    ),
    handoffMinPlannerConfidence: Math.min(
      1,
      Math.max(
        0,
        subagents?.handoffMinPlannerConfidence ??
          DEFAULT_HANDOFF_MIN_PLANNER_CONFIDENCE,
      ),
    ),
    forceVerifier: !unsafeBenchmarkMode && subagents?.forceVerifier === true,
    allowParallelSubtasks: subagents?.allowParallelSubtasks !== false,
    hardBlockedTaskClasses: unsafeBenchmarkMode
      ? []
      :
      Array.isArray(subagents?.hardBlockedTaskClasses) &&
      subagents.hardBlockedTaskClasses.length > 0
        ? subagents.hardBlockedTaskClasses.filter(
            (entry: string): entry is DelegationHardBlockedTaskClass =>
              entry === "wallet_signing" ||
              entry === "wallet_transfer" ||
              entry === "stake_or_rewards" ||
              entry === "destructive_host_mutation" ||
              entry === "credential_exfiltration",
          )
        : [...DEFAULT_HARD_BLOCKED_TASK_CLASSES],
    allowedParentTools: subagents?.allowedParentTools,
    forbiddenParentTools: subagents?.forbiddenParentTools,
    childToolAllowlistStrategy:
      subagents?.childToolAllowlistStrategy ?? "inherit_intersection",
    childProviderStrategy:
      subagents?.childProviderStrategy === "capability_matched"
        ? "capability_matched"
        : "same_as_parent",
    fallbackBehavior:
      subagents?.fallbackBehavior ?? "continue_without_delegation",
  };
}

export function requiresSubAgentInfrastructureRecreate(
  previous: ResolvedSubAgentRuntimeConfig | null,
  next: ResolvedSubAgentRuntimeConfig,
  currentManager: SubAgentManager | null,
  currentIsolationManager: SessionIsolationManager | null,
): boolean {
  if (!next.enabled) {
    return currentManager !== null || currentIsolationManager !== null;
  }
  if (!currentManager || !currentIsolationManager) {
    return true;
  }
  if (!previous || !previous.enabled) {
    return true;
  }
  // Existing manager is runtime-bound to this limit.
  if (previous.maxConcurrent !== next.maxConcurrent) {
    return true;
  }
  return false;
}

export function createDelegatingSubAgentLLMProvider(
  getProvider: () => LLMProvider | undefined,
): LLMProvider {
  const resolve = (): LLMProvider => {
    const provider = getProvider();
    if (!provider) {
      throw new Error("No LLM provider configured for sub-agent sessions");
    }
    return provider;
  };

  return {
    name: "subagent-delegating-provider",
    chat(messages, options) {
      return resolve().chat(messages, options);
    },
    chatStream(messages, onChunk, options) {
      return resolve().chatStream(messages, onChunk, options);
    },
    async healthCheck() {
      const provider = getProvider();
      if (!provider) return false;
      return provider.healthCheck();
    },
    async getExecutionProfile() {
      return (
        await resolve().getExecutionProfile?.()
      ) ?? { provider: resolve().name };
    },
    retrieveStoredResponse(responseId) {
      const provider = resolve();
      if (!provider.retrieveStoredResponse) {
        throw new Error("Active provider does not support stored response retrieval");
      }
      return provider.retrieveStoredResponse(responseId);
    },
    deleteStoredResponse(responseId) {
      const provider = resolve();
      if (!provider.deleteStoredResponse) {
        throw new Error("Active provider does not support stored response deletion");
      }
      return provider.deleteStoredResponse(responseId);
    },
  };
}

// ============================================================================
// Delegation aggressiveness + threshold helpers
// ============================================================================

export function getActiveDelegationAggressiveness(
  subAgentRuntimeConfig: ResolvedSubAgentRuntimeConfig | null,
  delegationAggressivenessOverride: DelegationAggressivenessProfile | null,
  resolved?: ResolvedSubAgentRuntimeConfig | null,
): DelegationAggressivenessProfile {
  const effectiveResolved = resolved ?? subAgentRuntimeConfig;
  return (
    delegationAggressivenessOverride ??
    effectiveResolved?.delegationAggressiveness ??
    "balanced"
  );
}

export function resolveDelegationScoreThreshold(
  subAgentRuntimeConfig: ResolvedSubAgentRuntimeConfig | null,
  delegationAggressivenessOverride: DelegationAggressivenessProfile | null,
  resolved?: ResolvedSubAgentRuntimeConfig | null,
): number {
  const effectiveResolved = resolved ?? subAgentRuntimeConfig;
  const baseThreshold =
    effectiveResolved?.baseSpawnDecisionThreshold ??
    effectiveResolved?.spawnDecisionThreshold ??
    0.65;
  return applyDelegationAggressiveness(
    baseThreshold,
    getActiveDelegationAggressiveness(
      subAgentRuntimeConfig,
      delegationAggressivenessOverride,
      effectiveResolved,
    ),
  );
}

// ============================================================================
// High-risk capability check
// ============================================================================

function hasHighRiskDelegationCapabilities(
  capabilities: readonly string[],
): boolean {
  for (const capability of capabilities) {
    const normalized = capability.trim().toLowerCase();
    if (!normalized) continue;
    if (
      normalized.startsWith("wallet.") ||
      normalized.startsWith("solana.") ||
      normalized.startsWith("agenc.") ||
      normalized.startsWith("desktop.") ||
      normalized.startsWith("playwright.") ||
      normalized === "system.http" ||
      normalized === "system.bash" ||
      normalized === "system.delete" ||
      normalized === "system.writefile" ||
      normalized === "system.execute" ||
      normalized === "system.open" ||
      normalized === "system.applescript" ||
      normalized === "system.notification"
    ) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Provider selection for sub-agent tasks
// ============================================================================

export function selectSubagentProviderForTask(
  requiredCapabilities: readonly string[] | undefined,
  fallbackProvider: LLMProvider,
  subAgentRuntimeConfig: ResolvedSubAgentRuntimeConfig | null,
  llmProviders: LLMProvider[],
): LLMProvider {
  const resolved = subAgentRuntimeConfig;
  if (!resolved) return fallbackProvider;
  if (resolved.childProviderStrategy !== "capability_matched") {
    return fallbackProvider;
  }

  const providers = llmProviders;
  if (providers.length === 0) return fallbackProvider;
  if (providers.length === 1) return providers[0] ?? fallbackProvider;

  const highRisk = hasHighRiskDelegationCapabilities(
    requiredCapabilities ?? [],
  );
  if (highRisk) return providers[0] ?? fallbackProvider;
  return providers[providers.length - 1] ?? fallbackProvider;
}

// ============================================================================
// Tool catalog refresh
// ============================================================================

export function refreshSubAgentToolCatalog(
  subAgentToolCatalog: Tool[],
  registry: import("../tools/registry.js").ToolRegistry,
  environment: ToolEnvironmentMode,
  options: {
    readonly includeStaticDesktopTools?: boolean;
  } = {},
): void {
  const tools = filterNamedToolsByEnvironment(
    registry.listAll(),
    environment,
  );
  const mergedTools = [...tools];
  if (options.includeStaticDesktopTools) {
    const knownToolNames = new Set(mergedTools.map((tool) => tool.name));
    const desktopTools = filterNamedToolsByEnvironment(
      STATIC_SUBAGENT_DESKTOP_TOOLS,
      environment,
    );
    for (const tool of desktopTools) {
      if (knownToolNames.has(tool.name)) {
        continue;
      }
      knownToolNames.add(tool.name);
      mergedTools.push(tool);
    }
  }
  subAgentToolCatalog.splice(
    0,
    subAgentToolCatalog.length,
    ...mergedTools,
  );
}

// ============================================================================
// Default workspace creation
// ============================================================================

export async function ensureSubAgentDefaultWorkspace(
  workspaceManager: WorkspaceManager,
  logger: Logger,
): Promise<void> {
  const defaultWorkspaceId = workspaceManager.getDefault();
  try {
    await workspaceManager.load(defaultWorkspaceId);
  } catch (error) {
    if (error instanceof WorkspaceValidationError && error.field === "path") {
      await workspaceManager.createWorkspace(defaultWorkspaceId);
      logger.info(
        `Created missing default workspace for sub-agent isolation: ${workspaceManager.basePath}/${defaultWorkspaceId}`,
      );
      return;
    }
    throw error;
  }
}

// ============================================================================
// Delegation runtime services configuration / teardown
// ============================================================================

interface DelegationRuntimeServicesState {
  delegationPolicyEngine: DelegationPolicyEngine | null;
  delegationVerifierService: DelegationVerifierService | null;
  subAgentLifecycleEmitter: SubAgentLifecycleEmitter | null;
  delegationTrajectorySink: InMemoryDelegationTrajectorySink | null;
}

export function configureDelegationRuntimeServices(
  resolved: ResolvedSubAgentRuntimeConfig,
  state: DelegationRuntimeServicesState,
  deps: {
    readonly subAgentRuntimeConfig: ResolvedSubAgentRuntimeConfig | null;
    readonly delegationAggressivenessOverride: DelegationAggressivenessProfile | null;
    readonly attachLifecycleBridge: () => void;
  },
): DelegationRuntimeServicesState {
  const policyConfig = {
    enabled: resolved.enabled,
    spawnDecisionThreshold: resolveDelegationScoreThreshold(
      deps.subAgentRuntimeConfig,
      deps.delegationAggressivenessOverride,
      resolved,
    ),
    allowedParentTools: resolved.allowedParentTools,
    forbiddenParentTools: resolved.forbiddenParentTools,
    fallbackBehavior: resolved.fallbackBehavior,
    unsafeBenchmarkMode: resolved.unsafeBenchmarkMode,
  } as const;
  let policyEngine = state.delegationPolicyEngine;
  if (policyEngine) {
    policyEngine.updateConfig(policyConfig);
  } else {
    policyEngine = new DelegationPolicyEngine(policyConfig);
  }

  const verifierConfig = {
    enabled: resolved.enabled && !resolved.unsafeBenchmarkMode,
    forceVerifier: !resolved.unsafeBenchmarkMode && resolved.forceVerifier,
  } as const;
  let verifierService = state.delegationVerifierService;
  if (verifierService) {
    verifierService.updateConfig(verifierConfig);
  } else {
    verifierService = new DelegationVerifierService(verifierConfig);
  }

  const lifecycleEmitter =
    state.subAgentLifecycleEmitter ?? new SubAgentLifecycleEmitter();
  const trajectorySink =
    state.delegationTrajectorySink ??
    new InMemoryDelegationTrajectorySink({ maxRecords: 50_000 });

  deps.attachLifecycleBridge();

  return {
    delegationPolicyEngine: policyEngine,
    delegationVerifierService: verifierService,
    subAgentLifecycleEmitter: lifecycleEmitter,
    delegationTrajectorySink: trajectorySink,
  };
}

export function clearDelegationRuntimeServices(
  detachLifecycleBridge: () => void,
  lifecycleEmitter: SubAgentLifecycleEmitter | null,
): DelegationRuntimeServicesState {
  detachLifecycleBridge();
  lifecycleEmitter?.clear();
  return {
    delegationPolicyEngine: null,
    delegationVerifierService: null,
    subAgentLifecycleEmitter: null,
    delegationTrajectorySink: null,
  };
}

// ============================================================================
// Sub-agent infrastructure destroy
// ============================================================================

export async function destroySubAgentInfrastructure(
  subAgentManager: SubAgentManager | null,
  sessionIsolationManager: SessionIsolationManager | null,
  logger: Logger,
): Promise<void> {
  if (subAgentManager) {
    try {
      await subAgentManager.destroyAll();
    } catch (error) {
      logger.warn?.(
        `Failed to destroy sub-agent manager: ${toErrorMessage(error)}`,
      );
    }
  }

  if (!sessionIsolationManager) return;

  const activeContexts = sessionIsolationManager.listActiveContexts();
  if (activeContexts.length === 0) return;
  await Promise.allSettled(
    activeContexts.map((contextKey) =>
      sessionIsolationManager.destroyContext(contextKey),
    ),
  );
}
