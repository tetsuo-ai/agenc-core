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
import type { HostToolingProfile } from "./host-tooling.js";
import type { ResolvedSubAgentRuntimeConfig } from "./subagent-infrastructure.js";
import type { GatewayLLMConfig } from "./types.js";
import {
  ToolPermissionEvaluator,
  evaluatorToCanUseTool,
  type ToolRule,
} from "../policy/tool-permission-evaluator.js";
import { BudgetStateService } from "../policy/budget-state.js";

/**
 * Cut 7: convert a gateway config tool allow/deny list into the
 * ToolRule[] shape the ToolPermissionEvaluator consumes. Deny rules
 * always win over allow rules; the evaluator preserves that ordering
 * when it walks the rule list.
 */
export function buildPermissionRulesFromAllowDeny(input: {
  readonly toolAllowList?: readonly string[];
  readonly toolDenyList?: readonly string[];
}): readonly ToolRule[] {
  const rules: ToolRule[] = [];
  for (const pattern of input.toolDenyList ?? []) {
    rules.push({
      pattern,
      effect: "deny",
      message: `Tool denied by gateway policy.toolDenyList rule: ${pattern}`,
    });
  }
  for (const pattern of input.toolAllowList ?? []) {
    rules.push({ pattern, effect: "allow" });
  }
  return rules;
}

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
  /** Optional agent identity provider (Phase 5.4). */
  identityProvider?: ChatExecutorConfig["identityProvider"];
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
  /** Provider configs aligned 1:1 with the provider chain, including auto-added fallbacks. */
  providerConfigs?: readonly GatewayLLMConfig[];
  /** Resolved subagent runtime config. */
  subagentConfig: ResolvedSubAgentRuntimeConfig;
  /** Callback to resolve dynamic delegation score threshold. */
  resolveDelegationScoreThreshold: () => number;
  /** Callback to resolve host tooling profile. */
  resolveHostToolingProfile: () => HostToolingProfile | null;
  /** Callback to resolve canonical host workspace root. */
  resolveHostWorkspaceRoot: () => string | null;
  /** Optional deterministic pipeline executor. */
  pipelineExecutor?: DeterministicPipelineExecutor;
  /**
   * Cut 7: optional permission rules. When provided, the factory
   * builds a ToolPermissionEvaluator from the rules + a fresh
   * BudgetStateService and wraps it as the chat-executor's
   * canUseTool seam (Cut 5.7). Empty rules array opts out of the
   * evaluator entirely; the existing approval flow continues to
   * gate tool calls through tool-handler-factory.
   */
  permissionRules?: readonly ToolRule[];
  /** Optional cap on tool call rate per minute (used by the budget service). */
  maxToolCallRatePerMinute?: number;
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
    providerConfigs: params.providerConfigs,
  });

  // Cut 7: build a ToolPermissionEvaluator + BudgetStateService when
  // the caller supplies permission rules, and adapt it to the
  // chat-executor's canUseTool seam (Cut 5.7). With no rules
  // configured the seam is not wired and the existing approval flow
  // remains the only gate.
  const canUseTool = (() => {
    if (!params.permissionRules || params.permissionRules.length === 0) {
      return undefined;
    }
    const evaluator = new ToolPermissionEvaluator({
      rules: params.permissionRules,
      budgetState: new BudgetStateService(),
      maxToolCallRatePerMinute: params.maxToolCallRatePerMinute,
    });
    return evaluatorToCanUseTool(evaluator);
  })();

  return new ChatExecutor({
    providers: params.providers,
    toolHandler: params.toolHandler,
    allowedTools: params.allowedTools,
    skillInjector: params.skillInjector,
    memoryRetriever: params.memoryRetriever,
    learningProvider: params.learningProvider,
    progressProvider: params.progressProvider,
    identityProvider: params.identityProvider,
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
      enabled: subagentConfig.enabled,
      force: subagentConfig.forceVerifier,
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
    ...(canUseTool ? { canUseTool } : {}),
  });
}
