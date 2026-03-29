/**
 * Factory for constructing ChatExecutor instances from gateway config.
 *
 * Extracts the duplicated ChatExecutor construction logic from daemon.ts
 * (wireWebChat + hotSwapLLMProvider) into a single reusable factory.
 *
 * Gate 3 — prerequisite reduction for planner/pipeline cross-cut.
 */

import { ChatExecutor } from "../llm/chat-executor.js";
import { buildModelRoutingPolicy } from "../llm/model-routing-policy.js";
import { buildRuntimeEconomicsPolicy } from "../llm/run-budget.js";
import type {
  ChatExecutorConfig,
  DeterministicPipelineExecutor,
  MemoryRetriever,
  SkillInjector,
} from "../llm/chat-executor-types.js";
import type { LLMProvider, ToolHandler } from "../llm/types.js";
import type {
  DelegationBanditPolicyTuner,
  DelegationTrajectorySink,
} from "../llm/delegation-learning.js";
import type { HostToolingProfile } from "./host-tooling.js";
import type { ResolvedSubAgentRuntimeConfig } from "./subagent-infrastructure.js";
import type { GatewayLLMConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Factory input
// ---------------------------------------------------------------------------

export interface CreateChatExecutorParams {
  /** LLM providers (if empty, returns null). */
  providers: LLMProvider[];
  /** Base tool handler from ToolRegistry. */
  toolHandler: ToolHandler;
  /** Tool names advertised to the model. */
  allowedTools: readonly string[];
  /** Optional skill injector. */
  skillInjector?: SkillInjector;
  /** Optional memory retriever. */
  memoryRetriever?: MemoryRetriever;
  /** Optional learning provider. */
  learningProvider?: ChatExecutorConfig["learningProvider"];
  /** Optional progress provider. */
  progressProvider?: ChatExecutorConfig["progressProvider"];
  /** Prompt budget config. */
  promptBudget?: ChatExecutorConfig["promptBudget"];
  /** Max tool rounds per request. */
  maxToolRounds: number;
  /** Session token budget. */
  sessionTokenBudget?: ChatExecutorConfig["sessionTokenBudget"];
  /** Soft local compaction threshold. */
  sessionCompactionThreshold?: ChatExecutorConfig["sessionCompactionThreshold"];
  /** Compaction callback. */
  onCompaction?: ChatExecutorConfig["onCompaction"];
  /** Gateway LLM config (for planner, timeout, retry, circuit breaker settings). */
  llmConfig?: GatewayLLMConfig;
  /** Resolved subagent runtime config. */
  subagentConfig: ResolvedSubAgentRuntimeConfig;
  /** Callback to resolve dynamic delegation score threshold. */
  resolveDelegationScoreThreshold: () => number;
  /** Delegation learning sinks. */
  delegationLearning?: {
    trajectorySink?: DelegationTrajectorySink;
    banditTuner?: DelegationBanditPolicyTuner;
    defaultStrategyArmId?: string;
  };
  /** Callback to resolve host tooling profile. */
  resolveHostToolingProfile: () => HostToolingProfile | null;
  /** Callback to resolve canonical host workspace root. */
  resolveHostWorkspaceRoot: () => string | null;
  /** Optional deterministic pipeline executor. */
  pipelineExecutor?: DeterministicPipelineExecutor;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ChatExecutor from gateway-level config, or null if no providers.
 *
 * This centralizes the ~50-line construction block that was duplicated in
 * daemon.ts wireWebChat() and hotSwapLLMProvider().
 */
export function createChatExecutor(
  params: CreateChatExecutorParams,
): ChatExecutor | null {
  if (params.providers.length === 0) {
    return null;
  }

  const { subagentConfig, llmConfig } = params;
  const economicsPolicy = buildRuntimeEconomicsPolicy({
    sessionTokenBudget: params.sessionTokenBudget,
    plannerMaxTokens: llmConfig?.plannerMaxTokens,
    requestTimeoutMs: llmConfig?.requestTimeoutMs,
    childTimeoutMs: subagentConfig.defaultTimeoutMs,
    maxFanoutPerTurn: subagentConfig.maxFanoutPerTurn,
    mode: llmConfig?.economicsMode ?? "enforce",
  });
  const modelRoutingPolicy = buildModelRoutingPolicy({
    providers: params.providers,
    economicsPolicy,
    llmConfig,
  });

  return new ChatExecutor({
    providers: params.providers,
    toolHandler: params.toolHandler,
    allowedTools: params.allowedTools,
    skillInjector: params.skillInjector,
    memoryRetriever: params.memoryRetriever,
    learningProvider: params.learningProvider,
    progressProvider: params.progressProvider,
    promptBudget: params.promptBudget,
    maxToolRounds: params.maxToolRounds,
    plannerEnabled:
      llmConfig?.plannerEnabled ?? subagentConfig.enabled,
    plannerMaxTokens: llmConfig?.plannerMaxTokens,
    toolBudgetPerRequest: llmConfig?.toolBudgetPerRequest,
    maxModelRecallsPerRequest: llmConfig?.maxModelRecallsPerRequest,
    maxFailureBudgetPerRequest: llmConfig?.maxFailureBudgetPerRequest,
    delegationDecision: {
      enabled: subagentConfig.enabled,
      mode: subagentConfig.mode,
      scoreThreshold: subagentConfig.baseSpawnDecisionThreshold,
      maxFanoutPerTurn: subagentConfig.maxFanoutPerTurn,
      maxDepth: subagentConfig.maxDepth,
      handoffMinPlannerConfidence:
        subagentConfig.handoffMinPlannerConfidence,
      hardBlockedTaskClasses: subagentConfig.hardBlockedTaskClasses,
    },
    resolveDelegationScoreThreshold: params.resolveDelegationScoreThreshold,
    subagentVerifier: {
      enabled:
        subagentConfig.enabled &&
        !subagentConfig.unsafeBenchmarkMode,
      force: subagentConfig.forceVerifier,
    },
    delegationLearning: {
      trajectorySink: params.delegationLearning?.trajectorySink,
      banditTuner: params.delegationLearning?.banditTuner,
      defaultStrategyArmId:
        params.delegationLearning?.defaultStrategyArmId ?? "balanced",
    },
    toolCallTimeoutMs: llmConfig?.toolCallTimeoutMs,
    requestTimeoutMs: llmConfig?.requestTimeoutMs,
    retryPolicyMatrix: llmConfig?.retryPolicy,
    toolFailureCircuitBreaker: llmConfig?.toolFailureCircuitBreaker,
    resolveHostToolingProfile: params.resolveHostToolingProfile,
    resolveHostWorkspaceRoot: params.resolveHostWorkspaceRoot,
    pipelineExecutor: params.pipelineExecutor,
    sessionTokenBudget: params.sessionTokenBudget,
    sessionCompactionThreshold: params.sessionCompactionThreshold,
    onCompaction: params.onCompaction,
    economicsPolicy,
    modelRoutingPolicy,
  });
}
