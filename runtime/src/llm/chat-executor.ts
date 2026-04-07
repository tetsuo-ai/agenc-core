/**
 * ChatExecutor — message-oriented LLM executor with cooldown-based fallback.
 *
 * Unlike LLMTaskExecutor (which takes on-chain Tasks and returns bigints),
 * ChatExecutor takes text messages and conversation history, returning string
 * responses. It adds cooldown-based provider fallback and session-level token
 * budget tracking.
 *
 * @module
 */

import type {
  LLMProvider,
  LLMProviderEvidence,
  LLMMessage,
  LLMStatefulResumeAnchor,
  LLMStructuredOutputRequest,
  LLMToolChoice,
  LLMResponse,
  LLMUsage,
  StreamProgressCallback,
  ToolHandler,
} from "./types.js";
import type { ArtifactCompactionState } from "../memory/artifact-store.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import type {
  PromptBudgetConfig,
  PromptBudgetDiagnostics,
  PromptBudgetSection,
} from "./prompt-budget.js";
import type {
  LLMPipelineStopReason,
  LLMRetryPolicyMatrix,
} from "./policy.js";
import type {
  Pipeline,
  PipelineExecutionEvent,
  PipelineResult,
} from "../workflow/pipeline.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import type { WorkflowVerificationContract } from "../workflow/verification-obligations.js";
import type { HostToolingProfile } from "../gateway/host-tooling.js";
import { resolveWorkflowCompletionState } from "../workflow/completion-state.js";
import { deriveWorkflowProgressSnapshot } from "../workflow/completion-progress.js";
import { isDocumentationArtifactPath } from "../workflow/artifact-paths.js";
import {
  buildModelRoutingPolicy,
  getProviderRouteKey,
  resolveParallelToolCallPolicy,
  resolveModelRoute,
  type ModelRoutingPolicy,
} from "./model-routing-policy.js";
import { isConcordiaSimulationTurnMessage } from "./chat-executor-turn-contracts.js";
import {
  resolveDelegationDecisionConfig,
  type ResolvedDelegationDecisionConfig,
} from "./delegation-decision.js";
import {
  computeDelegationFinalReward,
  computeUsefulDelegationProxy,
  DELEGATION_USEFULNESS_PROXY_VERSION,
  type DelegationBanditPolicyTuner,
  type DelegationTrajectorySink,
} from "./delegation-learning.js";
// ---------------------------------------------------------------------------
// Imports from extracted sibling modules
// ---------------------------------------------------------------------------

import {
  annotateFailureError,
} from "./chat-executor-provider-retry.js";
import {
  ChatBudgetExceededError,
  buildDefaultExecutionContext,
} from "./chat-executor-types.js";
import type {
  DetailedSkillInjectionResult,
  SkillInjector,
  MemoryRetriever,
  ToolCallRecord,
  ChatExecutionTraceEvent,
  ChatExecuteParams,
  ChatPromptShape,
  ChatCallUsageRecord,
  ChatPlannerSummary,
  ChatExecutorResult,
  DeterministicPipelineExecutor,
  ChatExecutorConfig,
  EvaluatorConfig,
  CooldownEntry,
  FallbackResult,
  ResolvedSubagentVerifierConfig,
  ExecutionContext,
} from "./chat-executor-types.js";
import {
  buildDelegationBudgetSnapshot,
  buildRuntimeEconomicsPolicy,
  buildRuntimeEconomicsSummary,
  getRuntimeBudgetPressure,
  mapPhaseToRunClass,
  recordRuntimeModelCall,
  type RuntimeEconomicsPolicy,
  type RuntimeRunClass,
} from "./run-budget.js";
import {
  hasRuntimeLimit,
  isRuntimeLimitReached,
  normalizeRuntimeLimit,
} from "./runtime-limit-policy.js";
import {
  MAX_EVAL_USER_CHARS,
  MAX_EVAL_RESPONSE_CHARS,
  MAX_CONTEXT_INJECTION_CHARS,
  MAX_PROMPT_CHARS_BUDGET,
  DEFAULT_MAX_RUNTIME_SYSTEM_HINTS,
  DEFAULT_PLANNER_MAX_TOKENS,
  DEFAULT_TOOL_BUDGET_PER_REQUEST,
  DEFAULT_MODEL_RECALLS_PER_REQUEST,
  DEFAULT_FAILURE_BUDGET_PER_REQUEST,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_ADAPTIVE_TOOL_ROUNDS,
  DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE,
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
  DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD,
  DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS,
  DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS,
  DEFAULT_EVAL_RUBRIC,
  MAX_COMPACT_INPUT,
  RECOVERY_HINT_PREFIX,
} from "./chat-executor-constants.js";
import {
  buildRequiredToolEvidenceRetryInstruction,
  canRetryDelegatedOutputWithoutAdditionalToolCalls,
  requiresWorkflowOwnedImplementationCompletion,
  resolveCorrectionAllowedToolNames,
  resolveExecutionToolContractGuidance,
  resolveLegacyCompletionCompatibility,
  resolveRuntimeWorkflowContext,
  type RuntimeWorkflowContextResolution,
  validateRequiredToolEvidence,
} from "./chat-executor-contract-flow.js";
import type { ToolContractGuidance } from "./chat-executor-contract-guidance.js";
import {
  didToolCallFail,
  resolveRetryPolicyMatrix,
} from "./chat-executor-tool-utils.js";
import {
  applyActiveRoutedToolNames,
  resolveEffectiveRoutedToolNames,
} from "./chat-executor-routing-state.js";
import { ToolFailureCircuitBreaker } from "./tool-failure-circuit-breaker.js";
import { compactHistoryIntoArtifactContext } from "./context-compaction.js";
import { selectRelevantArtifactRefs } from "./context-pruning.js";

function shouldUseSessionStatefulContinuationForPhase(
  phase: ChatCallUsageRecord["phase"],
): boolean {
  return phase === "initial" || phase === "tool_followup";
}

interface DetailedMemoryTraceEntry {
  readonly role?: string;
  readonly source?: string;
  readonly provenance?: string;
  readonly combinedScore?: number;
}

interface DetailedMemoryRetrievalResult {
  readonly content: string | undefined;
  readonly entries?: readonly DetailedMemoryTraceEntry[];
  readonly curatedIncluded?: boolean;
  readonly estimatedTokens?: number;
}

interface DetailedMemoryRetriever extends MemoryRetriever {
  retrieveDetailed(
    message: string,
    sessionId: string,
  ): Promise<DetailedMemoryRetrievalResult>;
}

interface DetailedSkillInjector extends SkillInjector {
  injectDetailed(
    message: string,
    sessionId: string,
  ): Promise<DetailedSkillInjectionResult>;
}

function isDetailedMemoryRetriever(
  provider: SkillInjector | MemoryRetriever | undefined,
): provider is DetailedMemoryRetriever {
  return (
    !!provider &&
    "retrieveDetailed" in provider &&
    typeof provider.retrieveDetailed === "function"
  );
}

function isDetailedSkillInjector(
  provider: SkillInjector | MemoryRetriever | undefined,
): provider is DetailedSkillInjector {
  return (
    !!provider &&
    "injectDetailed" in provider &&
    typeof provider.injectDetailed === "function"
  );
}

function mergeProviderEvidence(
  current: LLMProviderEvidence | undefined,
  incoming: LLMProviderEvidence | undefined,
): LLMProviderEvidence | undefined {
  if (!current) return incoming;
  if (!incoming) return current;

  const citations = Array.from(new Set([
    ...(current.citations ?? []),
    ...(incoming.citations ?? []),
  ]));
  const serverSideToolCalls = [
    ...(current.serverSideToolCalls ?? []),
    ...(incoming.serverSideToolCalls ?? []),
  ];
  const serverSideToolUsageByCategory = new Map<string, number>();
  for (const entry of [
    ...(current.serverSideToolUsage ?? []),
    ...(incoming.serverSideToolUsage ?? []),
  ]) {
    serverSideToolUsageByCategory.set(
      entry.category,
      (serverSideToolUsageByCategory.get(entry.category) ?? 0) + entry.count,
    );
  }
  const serverSideToolUsage = [...serverSideToolUsageByCategory.entries()].map(
    ([category, count]) => ({
      category,
      toolType:
        [...(current.serverSideToolUsage ?? []), ...(incoming.serverSideToolUsage ?? [])]
          .find((entry) => entry.category === category)?.toolType,
      count,
    }),
  );
  if (
    citations.length === 0 &&
    serverSideToolCalls.length === 0 &&
    serverSideToolUsage.length === 0
  ) {
    return undefined;
  }
  return {
    ...(citations.length > 0 ? { citations } : {}),
    ...(serverSideToolCalls.length > 0 ? { serverSideToolCalls } : {}),
    ...(serverSideToolUsage.length > 0 ? { serverSideToolUsage } : {}),
  };
}

function mergeExplicitRequirementToolNames(
  primaryToolNames: readonly string[],
  secondaryToolNames: readonly string[],
  fallbackToolNames: readonly string[],
): readonly string[] {
  const merged = Array.from(
    new Set([
      ...primaryToolNames,
      ...secondaryToolNames,
    ]),
  );
  if (merged.length > 0) {
    return merged;
  }
  return Array.from(new Set(fallbackToolNames));
}

function resolveWorkflowOwnerClass(params: {
  readonly workflowContext?: RuntimeWorkflowContextResolution;
  readonly plannerCompletionContract?: ImplementationCompletionContract;
  readonly plannerVerificationContract?: WorkflowVerificationContract;
}): "documentation" | "implementation" {
  const completionContract =
    params.workflowContext?.completionContract ??
    params.workflowContext?.verificationContract?.completionContract ??
    params.plannerCompletionContract ??
    params.plannerVerificationContract?.completionContract;
  if (completionContract?.placeholderTaxonomy === "documentation") {
    return "documentation";
  }
  const targetArtifacts =
    params.workflowContext?.verificationContract?.targetArtifacts ??
    params.plannerVerificationContract?.targetArtifacts ??
    [];
  if (
    targetArtifacts.length > 0 &&
    targetArtifacts.every((artifact) => isDocumentationArtifactPath(artifact)) &&
    completionContract?.taskClass !== "build_required" &&
    completionContract?.taskClass !== "behavior_required"
  ) {
    return "documentation";
  }
  return "implementation";
}

function buildDelegatedBudgetFinalizationInstruction(params: {
  readonly acceptanceCriteria?: readonly string[];
  readonly requestedToolNames: readonly string[];
}): string {
  const acceptanceSummary = (params.acceptanceCriteria ?? [])
    .filter((criterion) => typeof criterion === "string" && criterion.trim().length > 0)
    .slice(0, 4)
    .join("; ");
  const requestedToolSummary = params.requestedToolNames.length > 0
    ? ` The last tool request was not executed because the budget was exhausted: ${
      params.requestedToolNames.join(", ")
    }.`
    : "";

  return (
    "Tool-call budget is exhausted for this delegated phase. " +
    "Do not request more tools. " +
    "Using only the authoritative runtime tool ledger and tool results already collected, " +
    "produce the final grounded phase result now. " +
    "Only claim work backed by executed tool results, and explicitly name the concrete files or artifacts created or updated. " +
    "If any acceptance criterion is still unmet, state exactly which one lacks evidence instead of requesting another tool." +
    (acceptanceSummary.length > 0
      ? ` Acceptance criteria: ${acceptanceSummary}.`
      : "") +
    requestedToolSummary
  );
}

const MAX_PLAN_ONLY_EXECUTION_CORRECTIONS = 2;
const MAX_PARTIAL_CONTINUATION_CORRECTIONS = 1;

function buildPlanOnlyExecutionRetryInstruction(
  allowedToolNames: readonly string[],
): string {
  const allowedToolSummary = allowedToolNames.length > 0
    ? ` Allowed tools for this turn: ${allowedToolNames.slice(0, 12).join(", ")}${allowedToolNames.length > 12 ? ", ..." : ""}.`
    : "";
  return (
    "Do not stop after a plan for this turn. " +
    "The user asked you to execute work in the environment, so start performing the requested file or system actions immediately using tools. " +
    "Only answer after tool results show what you actually completed. " +
    "If execution is blocked, state the concrete blocker instead of returning another plan." +
    allowedToolSummary
  );
}

function buildWorkflowContinuationRetryInstruction(params: {
  readonly allowedToolNames: readonly string[];
  readonly progress: NonNullable<ReturnType<typeof deriveWorkflowProgressSnapshot>>;
}): string {
  const allowedToolSummary = params.allowedToolNames.length > 0
    ? ` Allowed tools for this turn: ${params.allowedToolNames.slice(0, 12).join(", ")}${params.allowedToolNames.length > 12 ? ", ..." : ""}.`
    : "";
  const remainingMilestones = (params.progress.remainingMilestones ?? [])
    .map((milestone) => milestone.description.trim())
    .filter((description) => description.length > 0)
    .slice(0, 4);
  const remainingRequirements = params.progress.remainingRequirements
    .filter((requirement) => requirement !== "request_milestones")
    .map((requirement) => requirement.replace(/_/g, " "))
    .slice(0, 4);
  const remainingSummaryParts: string[] = [];
  if (remainingMilestones.length > 0) {
    remainingSummaryParts.push(`Remaining request milestones: ${remainingMilestones.join("; ")}`);
  }
  if (remainingRequirements.length > 0) {
    remainingSummaryParts.push(`Remaining execution requirements: ${remainingRequirements.join("; ")}`);
  }
  const remainingSummary = remainingSummaryParts.length > 0
    ? ` ${remainingSummaryParts.join(". ")}.`
    : "";
  return (
    "Do not stop with a partial progress summary while request-level work remains incomplete. " +
    "Continue executing the remaining work with tools now. " +
    "Only stop if the remaining milestones are actually complete in the tool ledger, or if you hit a concrete blocker that prevents further execution." +
    remainingSummary +
    allowedToolSummary
  );
}
import type {
  ToolRoundProgressSummary,
} from "./chat-executor-tool-utils.js";
import {
  extractMessageText,
  truncateText,
  sanitizeFinalContent,
  reconcileDirectShellObservationContent,
  reconcileExactResponseContract,
  reconcileTerminalCompletionStateContent,
  reconcileVerifiedFileWorkflowContent,
  reconcileStructuredToolOutcome,
  reconcileTerminalFailureContent,
  normalizeHistory,
  normalizeHistoryForStatefulReconciliation,
  toStatefulReconciliationMessage,
  appendUserMessage,
  buildToolExecutionGroundingMessage,
  isPlanOnlyExecutionResponse,
  isExecutionDeferralResponse,
} from "./chat-executor-text.js";
import {
  summarizeStateful,
  computeQualityProxy,
  buildDelegationTrajectoryEntry,
  buildPlannerSummary,
} from "./chat-executor-recovery.js";
import {
  assessPlannerDecision,
  extractExplicitDeterministicToolRequirements,
  extractExplicitSubagentOrchestrationRequirements,
  requestRequiresToolGroundedExecution,
} from "./chat-executor-planner.js";
import {
  evaluateToolRoundBudgetExtension as evaluateToolRoundBudgetExtensionFn,
} from "./chat-executor-budget-extension.js";
import {
  callWithFallback as callWithFallbackFn,
} from "./chat-executor-fallback.js";
import {
  executePlannerPath as executePlannerPathFn,
} from "./chat-executor-planner-execution.js";
import {
  deriveActiveTaskContext,
  mergeTurnExecutionRequiredToolEvidence,
  resolveTurnExecutionContract,
} from "./turn-execution-contract.js";
import {
  executeToolCallLoop as executeToolCallLoopFn,
} from "./chat-executor-tool-loop.js";
export type {
  ToolRoundBudgetExtensionResult,
} from "./chat-executor-budget-extension.js";
// ---------------------------------------------------------------------------
// Re-exports — preserve backward-compatible import paths for consumers
// ---------------------------------------------------------------------------

export { ChatBudgetExceededError } from "./chat-executor-types.js";
export type {
  SkillInjector,
  MemoryRetriever,
  ToolCallRecord,
  ChatExecuteParams,
  ChatPromptShape,
  ChatCallUsageRecord,
  ChatPlannerSummary,
  PlannerDiagnostic,
  ChatStatefulSummary,
  ChatToolRoutingSummary,
  ChatExecutorResult,
  DeterministicPipelineExecutor,
  LLMRetryPolicyOverrides,
  ToolFailureCircuitBreakerConfig,
  ChatExecutorConfig,
  EvaluatorConfig,
  EvaluationResult,
} from "./chat-executor-types.js";


// ============================================================================
// ChatExecutor
// ============================================================================

/**
 * Message-oriented LLM executor with cooldown-based provider fallback
 * and session-level token budget tracking.
 */
export class ChatExecutor {
  private readonly providers: readonly LLMProvider[];
  private readonly toolHandler?: ToolHandler;
  private readonly maxToolRounds: number;
  private readonly onStreamChunk?: StreamProgressCallback;
  private readonly allowedTools: Set<string> | null;
  private readonly sessionTokenBudget?: number;
  private readonly sessionCompactionThreshold?: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly maxTrackedSessions: number;
  private readonly skillInjector?: SkillInjector;
  private readonly memoryRetriever?: MemoryRetriever;
  private readonly learningProvider?: MemoryRetriever;
  private readonly progressProvider?: MemoryRetriever;
  private readonly identityProvider?: MemoryRetriever;
  private readonly promptBudget: PromptBudgetConfig;
  private readonly maxRuntimeSystemHints: number;
  private readonly onCompaction?: (sessionId: string, summary: string) => void;
  private readonly evaluator?: EvaluatorConfig;
  private readonly plannerEnabled: boolean;
  private readonly plannerMaxTokens: number;
  private readonly delegationNestingDepth: number;
  private readonly pipelineExecutor?: DeterministicPipelineExecutor;
  private readonly delegationDecisionConfig: ResolvedDelegationDecisionConfig;
  private readonly resolveDelegationScoreThreshold?: () => number | undefined;
  private readonly subagentVerifierConfig: ResolvedSubagentVerifierConfig;
  private readonly delegationTrajectorySink?: DelegationTrajectorySink;
  private readonly delegationBanditTuner?: DelegationBanditPolicyTuner;
  private readonly delegationDefaultStrategyArmId: string;
  private readonly toolBudgetPerRequest: number;
  private readonly maxModelRecallsPerRequest: number;
  private readonly maxFailureBudgetPerRequest: number;
  private readonly toolCallTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  private readonly toolFailureBreaker: ToolFailureCircuitBreaker;
  private readonly resolveHostToolingProfile?: () => HostToolingProfile | null;
  private readonly resolveHostWorkspaceRoot?: () => string | null;
  private readonly economicsPolicy: RuntimeEconomicsPolicy;
  private readonly modelRoutingPolicy: ModelRoutingPolicy;
  private readonly defaultRunClass?: RuntimeRunClass;

  private readonly cooldowns = new Map<string, CooldownEntry>();
  private readonly sessionTokens = new Map<string, number>();

  private static normalizeRequestTimeoutMs(timeoutMs: number | undefined): number {
    return normalizeRuntimeLimit(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  constructor(config: ChatExecutorConfig) {
    if (!config.providers || config.providers.length === 0) {
      throw new Error("ChatExecutor requires at least one provider");
    }
    this.providers = config.providers;
    this.toolHandler = config.toolHandler;
    this.maxToolRounds = normalizeRuntimeLimit(
      config.maxToolRounds,
      MAX_ADAPTIVE_TOOL_ROUNDS,
    );
    this.onStreamChunk = config.onStreamChunk;
    this.allowedTools = config.allowedTools
      ? new Set(config.allowedTools)
      : null;
    this.sessionTokenBudget = config.sessionTokenBudget;
    this.sessionCompactionThreshold = config.sessionCompactionThreshold;
    this.cooldownMs = Math.max(0, config.providerCooldownMs ?? 60_000);
    this.maxCooldownMs = Math.max(0, config.maxCooldownMs ?? 300_000);
    this.maxTrackedSessions = Math.max(1, config.maxTrackedSessions ?? 10_000);
    this.skillInjector = config.skillInjector;
    this.memoryRetriever = config.memoryRetriever;
    this.learningProvider = config.learningProvider;
    this.progressProvider = config.progressProvider;
    this.identityProvider = config.identityProvider;
    const configuredPromptBudget = config.promptBudget ?? {};
    this.promptBudget = {
      hardMaxPromptChars:
        configuredPromptBudget.hardMaxPromptChars ?? MAX_PROMPT_CHARS_BUDGET,
      ...configuredPromptBudget,
    };
    const maxRuntimeHints = configuredPromptBudget.maxRuntimeHints;
    this.maxRuntimeSystemHints =
      typeof maxRuntimeHints === "number" && Number.isFinite(maxRuntimeHints)
        ? Math.max(0, Math.floor(maxRuntimeHints))
        : DEFAULT_MAX_RUNTIME_SYSTEM_HINTS;
    this.onCompaction = config.onCompaction;
    this.evaluator = config.evaluator;
    this.plannerEnabled = config.plannerEnabled ?? false;
    this.plannerMaxTokens = normalizeRuntimeLimit(
      config.plannerMaxTokens,
      DEFAULT_PLANNER_MAX_TOKENS,
    );
    this.delegationNestingDepth = Math.max(
      0,
      Math.floor(config.delegationNestingDepth ?? 0),
    );
    this.pipelineExecutor = config.pipelineExecutor;
    this.delegationDecisionConfig = resolveDelegationDecisionConfig(
      config.delegationDecision,
    );
    this.resolveDelegationScoreThreshold = config.resolveDelegationScoreThreshold;
    this.resolveHostToolingProfile = config.resolveHostToolingProfile;
    this.resolveHostWorkspaceRoot = config.resolveHostWorkspaceRoot;
    this.subagentVerifierConfig = ChatExecutor.resolveSubagentVerifierConfig(
      config.subagentVerifier,
    );
    this.delegationTrajectorySink = config.delegationLearning?.trajectorySink;
    this.delegationBanditTuner = config.delegationLearning?.banditTuner;
    this.delegationDefaultStrategyArmId =
      config.delegationLearning?.defaultStrategyArmId?.trim() || "balanced";
    this.toolBudgetPerRequest = normalizeRuntimeLimit(
      config.toolBudgetPerRequest,
      DEFAULT_TOOL_BUDGET_PER_REQUEST,
    );
    this.maxModelRecallsPerRequest = normalizeRuntimeLimit(
      config.maxModelRecallsPerRequest,
      DEFAULT_MODEL_RECALLS_PER_REQUEST,
    );
    this.maxFailureBudgetPerRequest = normalizeRuntimeLimit(
      config.maxFailureBudgetPerRequest,
      DEFAULT_FAILURE_BUDGET_PER_REQUEST,
    );
    this.toolCallTimeoutMs = normalizeRuntimeLimit(
      config.toolCallTimeoutMs,
      DEFAULT_TOOL_CALL_TIMEOUT_MS,
    );
    this.requestTimeoutMs = ChatExecutor.normalizeRequestTimeoutMs(
      config.requestTimeoutMs,
    );
    this.retryPolicyMatrix = resolveRetryPolicyMatrix(config.retryPolicyMatrix);
    this.toolFailureBreaker = new ToolFailureCircuitBreaker({
      enabled: config.toolFailureCircuitBreaker?.enabled ?? true,
      windowMs: Math.max(
        1_000,
        Math.floor(
          config.toolFailureCircuitBreaker?.windowMs ??
            DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS,
        ),
      ),
      threshold: Math.max(
        2,
        Math.floor(
          config.toolFailureCircuitBreaker?.threshold ??
            DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD,
        ),
      ),
      cooldownMs: Math.max(
        1_000,
        Math.floor(
          config.toolFailureCircuitBreaker?.cooldownMs ??
            DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS,
        ),
      ),
      maxTrackedSessions: this.maxTrackedSessions,
    });
    this.economicsPolicy = config.economicsPolicy ?? buildRuntimeEconomicsPolicy({
      sessionTokenBudget: this.sessionTokenBudget,
      plannerMaxTokens: this.plannerMaxTokens,
      requestTimeoutMs: this.requestTimeoutMs,
      mode: "enforce",
    });
    this.modelRoutingPolicy = config.modelRoutingPolicy ?? buildModelRoutingPolicy({
      providers: this.providers,
      economicsPolicy: this.economicsPolicy,
    });
    this.defaultRunClass = config.defaultRunClass;
  }

  private static resolveSubagentVerifierConfig(
    config: ChatExecutorConfig["subagentVerifier"] | undefined,
  ): ResolvedSubagentVerifierConfig {
    const maxRoundsRaw = config?.maxRounds ?? DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS;
    return {
      enabled: config?.enabled === true,
      force: config?.force === true,
      minConfidence: Math.min(
        1,
        Math.max(
          0,
          config?.minConfidence ?? DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE,
        ),
      ),
      maxRounds: normalizeRuntimeLimit(
        maxRoundsRaw,
        DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
      ),
    };
  }

  /**
   * Execute a chat message against the provider chain.
   */
  async execute(params: ChatExecuteParams): Promise<ChatExecutorResult> {
    return this.executeRequest(params);
  }

  private async executeRequest(
    params: ChatExecuteParams,
  ): Promise<ChatExecutorResult> {
    const ctx = await this.initializeExecutionContext(params);

    // Planner path (complexity-based delegation)
    if (
      this.plannerEnabled &&
      ctx.plannerDecision.shouldPlan &&
      this.pipelineExecutor &&
      ctx.activeToolHandler
    ) {
      await this.executePlannerPath(ctx);
    }

    // Direct path: initial LLM call + tool loop
    if (!ctx.plannerHandled) {
      const plannerFallbackBarrier = this.resolvePlannerFallbackBarrier(ctx);
      if (plannerFallbackBarrier) {
        this.emitExecutionTrace(ctx, {
          type: "planner_path_finished",
          phase: "planner",
          callIndex: ctx.callIndex,
          payload: {
            routeReason: ctx.plannerSummaryState.routeReason,
            stopReason: "validation_error",
            stopReasonDetail: plannerFallbackBarrier.stopReasonDetail,
            diagnostics: ctx.plannerSummaryState.diagnostics,
            handled: true,
            enforcement: plannerFallbackBarrier.enforcement,
          },
        });
        this.setStopReason(
          ctx,
          "validation_error",
          plannerFallbackBarrier.stopReasonDetail,
        );
        ctx.finalContent = plannerFallbackBarrier.finalContent;
        ctx.plannerHandled = true;
      } else {
        await this.executeToolCallLoop(ctx);
      }
    }

    this.enforceLegacyCompletionCompatibilityBeforeFinalization(ctx);

    this.checkRequestTimeout(ctx, "finalization");
    this.synchronizeCompletionState(ctx);

    // Optional response evaluation (critic)
    if (this.evaluator && ctx.finalContent && ctx.completionState === "completed") {
      await this.evaluateAndRetryResponse(ctx);
    }

    this.synchronizeCompletionState(ctx);

    // Finalization, trajectory recording, bandit outcome
    const { plannerSummary, durationMs } = this.recordOutcomeAndFinalize(ctx);

    // Sanitize + assemble result
    ctx.finalContent = sanitizeFinalContent(ctx.finalContent);
    ctx.finalContent = reconcileDirectShellObservationContent(
      ctx.finalContent,
      ctx.allToolCalls,
    );
    ctx.finalContent = reconcileVerifiedFileWorkflowContent(
      ctx.finalContent,
      ctx.allToolCalls,
    );
    ctx.finalContent = reconcileExactResponseContract(
      ctx.finalContent,
      ctx.allToolCalls,
      ctx.messageText,
      {
        metadata: ctx.message.metadata,
        forceLiteralWhenNoToolEvidence:
          plannerSummary?.routeReason === "exact_response_turn" ||
          plannerSummary?.routeReason === "dialogue_memory_turn",
      },
    );
    ctx.finalContent = reconcileStructuredToolOutcome(
      ctx.finalContent,
      ctx.allToolCalls,
      ctx.messageText,
    );
    const workflowContext = this.resolveWorkflowVerificationContext(ctx);
    const completionProgress = deriveWorkflowProgressSnapshot({
      stopReason: ctx.stopReason,
      completionState: ctx.completionState,
      stopReasonDetail: ctx.stopReasonDetail,
      validationCode: ctx.validationCode,
      toolCalls: ctx.allToolCalls,
      verificationContract: workflowContext.verificationContract,
      completionContract: workflowContext.completionContract,
      completedRequestMilestoneIds: ctx.completedRequestMilestoneIds,
      updatedAt: Date.now(),
      contractFingerprint: ctx.turnExecutionContract.contractFingerprint,
      verifier: {
        performed: ctx.plannerSummaryState.subagentVerification.performed,
        overall: ctx.plannerSummaryState.subagentVerification.overall,
      },
    });

    ctx.finalContent = reconcileTerminalFailureContent({
      content: ctx.finalContent,
      stopReason: ctx.stopReason,
      stopReasonDetail: ctx.stopReasonDetail,
      toolCalls: ctx.allToolCalls,
    });
    ctx.finalContent = reconcileTerminalCompletionStateContent({
      content: ctx.finalContent,
      completionState: ctx.completionState,
      stopReason: ctx.stopReason,
      stopReasonDetail: ctx.stopReasonDetail,
      toolCalls: ctx.allToolCalls,
      completionProgress,
    });
    ctx.finalContent = sanitizeFinalContent(ctx.finalContent);

    return {
      content: ctx.finalContent,
      provider: ctx.providerName,
      model: ctx.responseModel,
      usedFallback: ctx.usedFallback,
      toolCalls: ctx.allToolCalls,
      providerEvidence: ctx.providerEvidence,
      tokenUsage: ctx.cumulativeUsage,
      callUsage: ctx.callUsage,
      durationMs,
      compacted: ctx.compacted,
      statefulSummary: summarizeStateful(ctx.callUsage),
      toolRoutingSummary: ctx.toolRouting
        ? {
          enabled: true,
          initialToolCount: ctx.initialRoutedToolNames.length,
          finalToolCount: ctx.activeRoutedToolNames.length,
          routeMisses: ctx.routedToolMisses,
          expanded: ctx.routedToolsExpanded,
        }
        : undefined,
      plannerSummary,
      economicsSummary: buildRuntimeEconomicsSummary(
        this.economicsPolicy,
        ctx.economicsState,
      ),
      stopReason: ctx.stopReason,
      completionState: ctx.completionState,
      completionProgress,
      turnExecutionContract: ctx.turnExecutionContract,
      activeTaskContext: deriveActiveTaskContext(ctx.turnExecutionContract),
      stopReasonDetail: ctx.stopReasonDetail,
      validationCode: ctx.validationCode,
      evaluation: ctx.evaluation,
    };
  }

  // ===========================================================================
  // Utility helpers extracted from executeRequest() closures (Steps 2-6)
  // ===========================================================================

  private pushMessage(
    ctx: ExecutionContext,
    nextMessage: LLMMessage,
    section: PromptBudgetSection,
    reconciliationMessage?: LLMMessage,
  ): void {
    ctx.messages.push(nextMessage);
    ctx.reconciliationMessages.push(
      toStatefulReconciliationMessage(reconciliationMessage ?? nextMessage),
    );
    ctx.messageSections.push(section);
  }

  /**
   * Set the pipeline stop reason. Implements the canonical "first
   * non-completed reason wins" precedence: a stop reason can only be
   * recorded when the current stop reason is `"completed"` (the initial
   * state). Subsequent calls are silently dropped to preserve the
   * authoritative first failure rather than letting later phases
   * overwrite it with looser codes.
   *
   * The only legitimate bypass paths are documented at their call sites:
   *   - The supersededStopReason reset around line 1890 (rolls a
   *     soft validation_error back to completed when a follow-up call
   *     produced a clean response).
   *   - The snapshot restore in chat-executor-planner-execution.ts
   *     around line 1965 (restores the pre-synthesis stop reason after
   *     a failed synthesis attempt).
   * Any other direct `ctx.stopReason = ...` assignment is a bug — it
   * silently overwrites the authoritative stop reason. See audit S1.3.
   */
  private setStopReason(
    ctx: ExecutionContext,
    reason: LLMPipelineStopReason,
    detail?: string,
  ): void {
    if (ctx.stopReason === "completed") {
      ctx.stopReason = reason;
      ctx.stopReasonDetail = detail;
    }
  }

  private resolveWorkflowVerificationContext(ctx: ExecutionContext): {
    verificationContract?: WorkflowVerificationContract;
    completionContract?: ImplementationCompletionContract;
  } {
    const workflowContext = resolveRuntimeWorkflowContext({ ctx });
    return {
      verificationContract: workflowContext.verificationContract,
      completionContract: workflowContext.completionContract,
    };
  }

  private synchronizeCompletionState(ctx: ExecutionContext): void {
    const workflowContext = this.resolveWorkflowVerificationContext(ctx);
    ctx.completionState = resolveWorkflowCompletionState({
      stopReason: ctx.stopReason,
      toolCalls: ctx.allToolCalls,
      verificationContract: workflowContext.verificationContract,
      completionContract: workflowContext.completionContract,
      completedRequestMilestoneIds: ctx.completedRequestMilestoneIds,
      validationCode: ctx.validationCode,
      verifier: {
        performed: ctx.plannerSummaryState.subagentVerification.performed,
        overall: ctx.plannerSummaryState.subagentVerification.overall,
      },
    });
  }

  private deriveCurrentWorkflowProgress(
    ctx: ExecutionContext,
  ): ReturnType<typeof deriveWorkflowProgressSnapshot> {
    const workflowContext = this.resolveWorkflowVerificationContext(ctx);
    const completionState = resolveWorkflowCompletionState({
      stopReason: ctx.stopReason,
      toolCalls: ctx.allToolCalls,
      verificationContract: workflowContext.verificationContract,
      completionContract: workflowContext.completionContract,
      completedRequestMilestoneIds: ctx.completedRequestMilestoneIds,
      validationCode: ctx.validationCode,
      verifier: {
        performed: ctx.plannerSummaryState.subagentVerification.performed,
        overall: ctx.plannerSummaryState.subagentVerification.overall,
      },
    });
    const verifier = {
      performed: ctx.plannerSummaryState.subagentVerification.performed,
      overall: ctx.plannerSummaryState.subagentVerification.overall,
    };
    return deriveWorkflowProgressSnapshot({
      stopReason: ctx.stopReason,
      completionState,
      stopReasonDetail: ctx.stopReasonDetail,
      validationCode: ctx.validationCode,
      toolCalls: ctx.allToolCalls,
      verificationContract: workflowContext.verificationContract,
      completionContract: workflowContext.completionContract,
      completedRequestMilestoneIds: ctx.completedRequestMilestoneIds,
      updatedAt: Date.now(),
      contractFingerprint: ctx.turnExecutionContract.contractFingerprint,
      verifier,
    });
  }

  private resolvePlannerFallbackBarrier(
    ctx: ExecutionContext,
  ):
    | {
      readonly stopReasonDetail: string;
      readonly finalContent: string;
      readonly enforcement:
        | "executor_level_planner_veto_barrier"
        | "executor_level_planner_parse_barrier";
    }
    | undefined {
    if (!ctx.plannerImplementationFallbackBlocked || ctx.plannerHandled) {
      return undefined;
    }
    const delegationDecision = ctx.plannerSummaryState.delegationDecision;
    if (delegationDecision && delegationDecision.shouldDelegate === false && ctx.plannedSubagentSteps > 0) {
      return {
        stopReasonDetail:
          "Planner produced an implementation-scoped delegated plan, but runtime delegation admission rejected it. Inline legacy fallback is disabled for this task class.",
        finalContent:
          "Planner produced an implementation-scoped delegated plan, " +
          `but runtime delegation admission rejected it (${ctx.plannerSummaryState.delegationDecision?.reason ?? "delegation_veto"}). ` +
          "Inline legacy fallback is disabled for this task class; re-plan the work with a single-owner execution contract or provide an explicit workflow verification contract.",
        enforcement: "executor_level_planner_veto_barrier",
      };
    }
    if (
      ctx.plannerSummaryState.routeReason === "planner_parse_failed" &&
      ctx.plannerSummaryState.diagnostics.some((diagnostic) =>
        diagnostic.code === "planner_step_contract_retry" ||
        diagnostic.code === "planner_required_orchestration_retry" ||
        diagnostic.code === "planner_parse_contract_retry"
      )
    ) {
      return {
        stopReasonDetail:
          "Planner could not produce a valid delegated execution plan after runtime validation retries. Inline legacy fallback is disabled for this task class.",
        finalContent:
          "Planner could not produce a valid delegated execution plan after runtime validation retries. " +
          "Inline legacy fallback is disabled for this task class; re-plan the work with a single-owner execution contract or provide an explicit workflow verification contract.",
        enforcement: "executor_level_planner_parse_barrier",
      };
    }
    return undefined;
  }

  private timeoutDetail(
    stage: string,
    requestTimeoutMs = this.requestTimeoutMs,
  ): string {
    if (requestTimeoutMs <= 0) {
      return `Request exceeded end-to-end timeout during ${stage}`;
    }
    return `Request exceeded end-to-end timeout (${requestTimeoutMs}ms) during ${stage}`;
  }

  private checkRequestTimeout(ctx: ExecutionContext, stage: string): boolean {
    if (this.getRemainingRequestMs(ctx) > 0) return false;
    this.setStopReason(
      ctx,
      "timeout",
      this.timeoutDetail(stage, ctx.effectiveRequestTimeoutMs),
    );
    return true;
  }

  private appendToolRecord(ctx: ExecutionContext, record: ToolCallRecord): void {
    ctx.allToolCalls.push(record);
    if (didToolCallFail(record.isError, record.result)) {
      ctx.failedToolCalls++;
    }
  }

  private hasModelRecallBudget(ctx: ExecutionContext): boolean {
    if (ctx.modelCalls === 0) return true;
    if (ctx.effectiveMaxModelRecalls <= 0) return true;
    return ctx.modelCalls - 1 < ctx.effectiveMaxModelRecalls;
  }

  private resolveRunClassForPhase(
    ctx: ExecutionContext,
    phase: ChatCallUsageRecord["phase"],
  ): RuntimeRunClass {
    if (
      isConcordiaSimulationTurnMessage(ctx.message) &&
      (phase === "initial" || phase === "tool_followup")
    ) {
      return "child";
    }
    return ctx.defaultRunClass ?? this.defaultRunClass ?? mapPhaseToRunClass(phase);
  }

  private resolveRoutingDecision(
    ctx: ExecutionContext,
    phase: ChatCallUsageRecord["phase"],
    requirements?: {
      readonly statefulContinuationRequired?: boolean;
      readonly structuredOutputRequired?: boolean;
      readonly routedToolNames?: readonly string[];
    },
  ) {
    const runClass = this.resolveRunClassForPhase(ctx, phase);
    const pressure = getRuntimeBudgetPressure(
      this.economicsPolicy,
      ctx.economicsState,
      runClass,
    );
    return {
      runClass,
      pressure,
      route: resolveModelRoute({
        policy: this.modelRoutingPolicy,
        runClass,
        pressure,
        degradedProviderNames: this.buildDegradedProviderNames(),
        requirements,
      }),
    };
  }

  private buildDegradedProviderNames(): readonly string[] {
    const now = Date.now();
    const names: string[] = [];
    for (const [providerName, cooldown] of this.cooldowns.entries()) {
      if (cooldown.availableAt > now) {
        names.push(providerName);
      }
    }
    return names;
  }

  private getRemainingRequestMs(ctx: ExecutionContext): number {
    if (ctx.effectiveRequestTimeoutMs <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return ctx.requestDeadlineAt - Date.now();
  }

  private serializeRequestTimeoutMs(timeoutMs: number): number | null {
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
  }

  private serializeRemainingRequestMs(remainingRequestMs: number): number | null {
    return Number.isFinite(remainingRequestMs)
      ? Math.max(0, remainingRequestMs)
      : null;
  }

  private evaluateToolRoundBudgetExtension(params: {
    readonly ctx: ExecutionContext;
    readonly currentLimit: number;
    readonly recentRounds: readonly ToolRoundProgressSummary[];
  }) {
    return evaluateToolRoundBudgetExtensionFn(
      params,
      (ctx) => this.getRemainingRequestMs(ctx),
    );
  }

  private emitExecutionTrace(
    ctx: ExecutionContext,
    event: ChatExecutionTraceEvent,
  ): void {
    ctx.trace?.onExecutionTraceEvent?.(event);
  }

  private emitPlannerTrace(
    ctx: ExecutionContext,
    type:
      | "planner_path_finished"
      | "planner_pipeline_finished"
      | "planner_synthesis_fallback_applied"
      | "planner_pipeline_started"
      | "planner_plan_parsed"
      | "planner_refinement_requested"
      | "planner_verifier_retry_scheduled"
      | "planner_verifier_round_finished",
    payload: Record<string, unknown>,
  ): void {
    if (type === "planner_path_finished") {
      this.synchronizeCompletionState(ctx);
      if (payload.completionState === undefined) {
        payload = {
          ...payload,
          completionState: ctx.completionState,
        };
      }
    }
    this.emitExecutionTrace(ctx, {
      type,
      phase: "planner",
      callIndex: ctx.callIndex + 1,
      payload,
    });
  }

  private emitPipelineExecutionTrace(
    ctx: ExecutionContext,
    event: PipelineExecutionEvent,
  ): void {
    if (event.type === "step_state_changed") {
      this.emitExecutionTrace(ctx, {
        type: "planner_step_state_changed",
        phase: "planner",
        callIndex: ctx.callIndex + 1,
        payload: {
          pipelineId: event.pipelineId,
          stepName: event.stepName,
          stepIndex: event.stepIndex,
          state: event.state,
          previousState: event.previousState,
          tool: event.tool,
          args: event.args,
          reason: event.reason,
          blockingDependencies: event.blockingDependencies,
        },
      });
      return;
    }
    if (event.type === "step_started") {
      this.emitExecutionTrace(ctx, {
        type: "tool_dispatch_started",
        phase: "planner",
        callIndex: ctx.callIndex + 1,
        payload: {
          pipelineId: event.pipelineId,
          stepName: event.stepName,
          stepIndex: event.stepIndex,
          tool: event.tool,
          args: event.args,
        },
      });
      return;
    }
    if (event.type === "step_finished") {
      if (typeof event.error === "string") {
        ctx.plannerFailedStep = {
          stepName: event.stepName,
          stepIndex: event.stepIndex,
          tool: event.tool,
          error: event.error,
        };
      } else if (
        ctx.plannerFailedStep &&
        (
          (
            typeof ctx.plannerFailedStep.stepName === "string" &&
            ctx.plannerFailedStep.stepName === event.stepName
          ) ||
          (
            typeof ctx.plannerFailedStep.stepIndex === "number" &&
            ctx.plannerFailedStep.stepIndex === event.stepIndex
          )
        )
      ) {
        ctx.plannerFailedStep = undefined;
      }
      this.emitExecutionTrace(ctx, {
        type: "tool_dispatch_finished",
        phase: "planner",
        callIndex: ctx.callIndex + 1,
        payload: {
          pipelineId: event.pipelineId,
          stepName: event.stepName,
          stepIndex: event.stepIndex,
          tool: event.tool,
          args: event.args,
          durationMs: event.durationMs,
          isError: typeof event.error === "string",
          ...(typeof event.result === "string"
            ? { result: event.result }
            : {}),
          ...(typeof event.error === "string"
            ? { error: event.error }
            : {}),
        },
      });
      return;
    }
    this.emitPlannerTrace(ctx, "planner_pipeline_finished", {
      pipelineId: event.pipelineId,
      halted: true,
      stepName: event.stepName,
      stepIndex: event.stepIndex,
      tool: event.tool,
      args: event.args,
      error: event.error,
    });
  }

  private maybePushRuntimeInstruction(
    ctx: ExecutionContext,
    content: string,
  ): void {
    const runtimeHintCount = ctx.messageSections.filter(
      (section) => section === "system_runtime",
    ).length;
    if (runtimeHintCount >= this.maxRuntimeSystemHints) return;

    const alreadyPresent = ctx.messages.some((message, index) => {
      if (ctx.messageSections[index] !== "system_runtime") return false;
      return message.role === "system" &&
        typeof message.content === "string" &&
        message.content === content;
    });
    if (alreadyPresent) return;

    this.pushMessage(ctx, { role: "system", content }, "system_runtime");
  }

  private replaceRuntimeRecoveryHintMessages(
    ctx: ExecutionContext,
    recoveryHints: readonly { key: string }[],
  ): void {
    const nextMessages: LLMMessage[] = [];
    const nextSections: PromptBudgetSection[] = [];
    for (let index = 0; index < ctx.messages.length; index++) {
      const message = ctx.messages[index];
      const section = ctx.messageSections[index];
      if (
        section === "system_runtime" &&
        message?.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith(RECOVERY_HINT_PREFIX)
      ) {
        continue;
      }
      nextMessages.push(message);
      nextSections.push(section);
    }
    ctx.messages = nextMessages;
    ctx.messageSections = nextSections;
    ctx.activeRecoveryHintKeys = recoveryHints.map((hint) => hint.key);
  }

  private resolveActiveToolContractGuidance(
    ctx: ExecutionContext,
    input?: {
      readonly phase?: "initial" | "tool_followup" | "correction";
      readonly allowedToolNames?: readonly string[];
      readonly validationCode?: DelegationOutputValidationCode;
    },
  ): ToolContractGuidance | undefined {
    const artifactTaskAllowedToolOverride =
      !input?.allowedToolNames && ctx.requiredToolEvidence?.artifactTaskContract
        ? this.allowedTools
          ? [...this.allowedTools]
          : ctx.expandedRoutedToolNames.length > 0
            ? [...ctx.expandedRoutedToolNames]
            : [...ctx.initialRoutedToolNames]
        : input?.allowedToolNames;
    return resolveExecutionToolContractGuidance({
      ctx: {
        ...ctx,
        messageMetadata: ctx.message.metadata,
      },
      allowedTools: this.allowedTools ?? undefined,
      phase: input?.phase,
      allowedToolNames: artifactTaskAllowedToolOverride,
      validationCode: input?.validationCode,
    });
  }

  private async enforceRequiredToolEvidenceBeforeCompletion(
    ctx: ExecutionContext,
    phase: "initial" | "tool_followup",
  ): Promise<"continue" | "failed" | "not_required"> {
    const hasRequiredEvidenceContract = Boolean(
      ctx.requiredToolEvidence?.delegationSpec ||
        ctx.requiredToolEvidence?.verificationContract ||
        ctx.requiredToolEvidence?.completionContract,
    );
    const artifactEnvelopeOnly = Boolean(
      ctx.requiredToolEvidence?.artifactTaskContract && !hasRequiredEvidenceContract,
    );
    if (!ctx.requiredToolEvidence || artifactEnvelopeOnly) {
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase,
        callIndex: ctx.callIndex,
        payload: {
          decision: "not_required",
          finishReason: ctx.response?.finishReason,
          ...(artifactEnvelopeOnly
            ? { reason: "artifact_task_execution_envelope_only" }
            : {}),
        },
      });
      return "not_required";
    }

    let retried = false;
    while (ctx.response?.finishReason !== "tool_calls") {
      const {
        contractValidation,
        missingEvidenceMessage,
      } = validateRequiredToolEvidence({ ctx });
      if (!missingEvidenceMessage) {
        ctx.validationCode = undefined;
        this.emitExecutionTrace(ctx, {
          type: "completion_gate_checked",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            decision: retried ? "accept_after_retry" : "accept",
            finishReason: ctx.response?.finishReason,
            correctionAttempts: ctx.requiredToolEvidenceCorrectionAttempts,
          },
        });
        return retried ? "continue" : "not_required";
      }

      const canRetryWithoutAdditionalToolCalls =
        canRetryDelegatedOutputWithoutAdditionalToolCalls({
          validationCode: contractValidation?.code,
          toolCalls: ctx.allToolCalls,
          delegationSpec: ctx.requiredToolEvidence.delegationSpec,
          providerEvidence: ctx.providerEvidence,
        });
      const allowFinalToollessRetry =
        canRetryWithoutAdditionalToolCalls &&
        ctx.requiredToolEvidenceCorrectionAttempts ===
          ctx.requiredToolEvidence.maxCorrectionAttempts;

      if (
        ctx.requiredToolEvidenceCorrectionAttempts >=
          ctx.requiredToolEvidence.maxCorrectionAttempts &&
        !allowFinalToollessRetry
      ) {
        this.emitExecutionTrace(ctx, {
          type: "completion_gate_checked",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            decision: "fail",
            finishReason: ctx.response?.finishReason,
            correctionAttempts: ctx.requiredToolEvidenceCorrectionAttempts,
            missingEvidenceMessage,
            validationCode: contractValidation?.code,
          },
        });
        ctx.validationCode = contractValidation?.code;
        this.setStopReason(ctx, "validation_error", missingEvidenceMessage);
        ctx.finalContent = missingEvidenceMessage;
        return "failed";
      }

      const correctionAllowedTools = canRetryWithoutAdditionalToolCalls
        ? []
        : resolveCorrectionAllowedToolNames(
          ctx.activeRoutedToolNames,
          this.allowedTools ?? undefined,
        );
      const retryInstruction = buildRequiredToolEvidenceRetryInstruction({
        missingEvidenceMessage,
        validationCode: contractValidation?.code,
        allowedToolNames: correctionAllowedTools,
        requiresAdditionalToolCalls: !canRetryWithoutAdditionalToolCalls,
      });

      if (
        typeof ctx.response?.content === "string" &&
        ctx.response.content.trim().length > 0
      ) {
        this.pushMessage(
          ctx,
          { role: "assistant", content: ctx.response.content, phase: "commentary" },
          "assistant_runtime",
        );
      }
      this.pushMessage(
        ctx,
        { role: "system", content: retryInstruction },
        "system_runtime",
      );
      ctx.requiredToolEvidenceCorrectionAttempts += 1;
      retried = true;
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase,
        callIndex: ctx.callIndex,
        payload: {
          decision: "retry",
          finishReason: ctx.response?.finishReason,
          correctionAttempts: ctx.requiredToolEvidenceCorrectionAttempts,
          missingEvidenceMessage,
          validationCode: contractValidation?.code,
          allowedToolNames: correctionAllowedTools,
          toollessRetry: canRetryWithoutAdditionalToolCalls,
        },
      });

      const correctionContractGuidance = canRetryWithoutAdditionalToolCalls
        ? undefined
        : this.resolveActiveToolContractGuidance(
          ctx,
          {
            phase: "correction",
            allowedToolNames: correctionAllowedTools,
            validationCode: contractValidation?.code,
          },
        );
      if (correctionContractGuidance) {
        this.emitExecutionTrace(ctx, {
          type: "contract_guidance_resolved",
          phase,
          callIndex: ctx.callIndex + 1,
          payload: {
            source: correctionContractGuidance.source,
            routedToolNames: correctionContractGuidance.routedToolNames ?? [],
            toolChoice:
              typeof correctionContractGuidance.toolChoice === "string"
                ? correctionContractGuidance.toolChoice
                : correctionContractGuidance.toolChoice.name,
            hasRuntimeInstruction: Boolean(
              correctionContractGuidance.runtimeInstruction,
            ),
          },
        });
      }
      const nextResponse = await this.callModelForPhase(ctx, {
        phase,
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        toolChoice:
          canRetryWithoutAdditionalToolCalls
            ? "none"
            : correctionContractGuidance?.toolChoice ?? "required",
        ...((correctionContractGuidance?.routedToolNames?.length ?? 0) > 0
          ? {
            routedToolNames: correctionContractGuidance!.routedToolNames,
            ...(correctionContractGuidance?.persistRoutedToolNames === false
              ? { persistRoutedToolNames: false }
              : {}),
          }
          : {}),
        budgetReason:
          "Max model recalls exceeded while enforcing delegated tool-grounded evidence",
      });
      if (!nextResponse) return "failed";
      ctx.response = nextResponse;
    }

    return retried ? "continue" : "not_required";
  }

  private async enforcePlanOnlyExecutionBeforeCompletion(
    ctx: ExecutionContext,
    phase: "initial" | "tool_followup",
  ): Promise<"continue" | "failed" | "not_required"> {
    const executionRequested = requestRequiresToolGroundedExecution(
      ctx.messageText,
    );
    const toolsAvailable = Boolean(ctx.activeToolHandler);
    if (!executionRequested || !toolsAvailable) {
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase,
        callIndex: ctx.callIndex,
        payload: {
          gate: "plan_only_execution",
          decision: "not_required",
          finishReason: ctx.response?.finishReason,
          executionRequested,
          toolsAvailable,
        },
      });
      return "not_required";
    }

    let correctionAttempts = 0;
    let retried = false;
    while (ctx.response?.finishReason !== "tool_calls") {
      const responseContent =
        typeof ctx.response?.content === "string"
          ? ctx.response.content.trim()
          : "";
      const planOnly =
        responseContent.length > 0 &&
        isPlanOnlyExecutionResponse(responseContent);
      const executionDeferred =
        phase === "tool_followup" &&
        responseContent.length > 0 &&
        isExecutionDeferralResponse(responseContent);
      if (!planOnly && !executionDeferred) {
        this.emitExecutionTrace(ctx, {
          type: "completion_gate_checked",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            gate: "plan_only_execution",
            decision: retried ? "accept_after_retry" : "accept",
            finishReason: ctx.response?.finishReason,
            correctionAttempts,
            executionDeferred: false,
          },
        });
        return retried ? "continue" : "not_required";
      }

      const allowedToolNames = resolveCorrectionAllowedToolNames(
        ctx.activeRoutedToolNames,
        this.allowedTools ?? undefined,
      );
      const failureMessage =
        executionDeferred
          ? "Execution task stopped with a progress summary that deferred remaining work. Continue executing with tools or report a concrete blocker instead of asking what to do next."
          : "Execution task returned only a plan without grounded tool work. Start executing with tools or report a concrete blocker instead of another plan.";
      if (correctionAttempts >= MAX_PLAN_ONLY_EXECUTION_CORRECTIONS) {
        this.emitExecutionTrace(ctx, {
          type: "completion_gate_checked",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            gate: "plan_only_execution",
            decision: "fail",
            finishReason: ctx.response?.finishReason,
            correctionAttempts,
            executionDeferred,
            responsePreview: truncateText(responseContent, 180),
          },
        });
        this.setStopReason(ctx, "validation_error", failureMessage);
        ctx.finalContent = failureMessage;
        return "failed";
      }

      if (responseContent.length > 0) {
        this.pushMessage(
          ctx,
          { role: "assistant", content: responseContent, phase: "commentary" },
          "assistant_runtime",
        );
      }
      this.pushMessage(
        ctx,
        {
          role: "system",
          content: buildPlanOnlyExecutionRetryInstruction(allowedToolNames),
        },
        "system_runtime",
      );
      correctionAttempts += 1;
      retried = true;
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase,
        callIndex: ctx.callIndex,
        payload: {
          gate: "plan_only_execution",
          decision: "retry",
          finishReason: ctx.response?.finishReason,
          correctionAttempts,
          executionDeferred,
          allowedToolNames,
          responsePreview: truncateText(responseContent, 180),
        },
      });

      const nextResponse = await this.callModelForPhase(ctx, {
        phase,
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        toolChoice: "required",
        budgetReason:
          "Max model recalls exceeded while retrying a plan-only execution response",
      });
      if (!nextResponse) return "failed";
      ctx.response = nextResponse;
    }

    return retried ? "continue" : "not_required";
  }

  private async enforceWorkflowContinuationBeforeCompletion(
    ctx: ExecutionContext,
    phase: "initial" | "tool_followup",
  ): Promise<"continue" | "failed" | "not_required"> {
    const executionRequested = requestRequiresToolGroundedExecution(
      ctx.messageText,
    );
    const toolsAvailable = Boolean(ctx.activeToolHandler);
    const trackedRequestMilestones = Boolean(
      ctx.plannerVerificationContract?.requestCompletion?.requiredMilestones
        ?.length ||
      ctx.completedRequestMilestoneIds.length > 0,
    );
    if (
      !ctx.response ||
      !executionRequested ||
      !trackedRequestMilestones ||
      !toolsAvailable ||
      ctx.response?.finishReason === "tool_calls" ||
      ctx.stopReason !== "completed"
    ) {
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase,
        callIndex: ctx.callIndex,
        payload: {
          gate: "workflow_continuation_truth",
          decision: "not_required",
          finishReason: ctx.response?.finishReason,
          executionRequested,
          trackedRequestMilestones,
          toolsAvailable,
          stopReason: ctx.stopReason,
        },
      });
      return "not_required";
    }

    let correctionAttempts = 0;
    let retried = false;
    while (ctx.response?.finishReason !== "tool_calls") {
      const progress = this.deriveCurrentWorkflowProgress(ctx);
      const requiresContinuation = Boolean(
        progress &&
        progress.completionState === "partial" &&
        (
          (progress.remainingMilestones?.length ?? 0) > 0 ||
          progress.remainingRequirements.includes("request_milestones")
        ),
      );
      if (!requiresContinuation || !progress) {
        if (progress) {
          ctx.completionState = progress.completionState;
          if (progress.satisfiedMilestoneIds) {
            ctx.completedRequestMilestoneIds = [
              ...progress.satisfiedMilestoneIds,
            ];
          }
        }
        this.emitExecutionTrace(ctx, {
          type: "completion_gate_checked",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            gate: "workflow_continuation_truth",
            decision: retried ? "accept_after_retry" : "accept",
            finishReason: ctx.response?.finishReason,
            correctionAttempts,
            completionState: progress?.completionState,
            remainingRequirements: progress?.remainingRequirements ?? [],
            remainingMilestones: (progress?.remainingMilestones ?? []).map((milestone) => ({
              id: milestone.id,
              description: milestone.description,
            })),
          },
        });
        return retried ? "continue" : "not_required";
      }

      const responseContent =
        typeof ctx.response?.content === "string"
          ? ctx.response.content.trim()
          : "";
      const allowedToolNames = resolveCorrectionAllowedToolNames(
        ctx.activeRoutedToolNames,
        this.allowedTools ?? undefined,
      );
      const remainingMilestones = (progress.remainingMilestones ?? [])
        .map((milestone) => milestone.description.trim())
        .filter((description) => description.length > 0);
      const failureMessage = remainingMilestones.length > 0
        ? `Execution stopped early with unfinished request milestones: ${remainingMilestones.join("; ")}. Continue executing instead of ending with a partial summary.`
        : "Execution stopped early with unfinished request-level work. Continue executing instead of ending with a partial summary.";
      if (correctionAttempts >= MAX_PARTIAL_CONTINUATION_CORRECTIONS) {
        this.emitExecutionTrace(ctx, {
          type: "completion_gate_checked",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            gate: "workflow_continuation_truth",
            decision: "fail",
            finishReason: ctx.response?.finishReason,
            correctionAttempts,
            completionState: progress.completionState,
            remainingRequirements: progress.remainingRequirements,
            remainingMilestones: (progress.remainingMilestones ?? []).map((milestone) => ({
              id: milestone.id,
              description: milestone.description,
            })),
            responsePreview: truncateText(responseContent, 180),
          },
        });
        this.setStopReason(ctx, "validation_error", failureMessage);
        ctx.finalContent = failureMessage;
        return "failed";
      }

      if (responseContent.length > 0) {
        this.pushMessage(
          ctx,
          { role: "assistant", content: responseContent, phase: "commentary" },
          "assistant_runtime",
        );
      }
      this.pushMessage(
        ctx,
        {
          role: "system",
          content: buildWorkflowContinuationRetryInstruction({
            allowedToolNames,
            progress,
          }),
        },
        "system_runtime",
      );
      correctionAttempts += 1;
      retried = true;
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase,
        callIndex: ctx.callIndex,
        payload: {
          gate: "workflow_continuation_truth",
          decision: "retry",
          finishReason: ctx.response?.finishReason,
          correctionAttempts,
          completionState: progress.completionState,
          remainingRequirements: progress.remainingRequirements,
          remainingMilestones: (progress.remainingMilestones ?? []).map((milestone) => ({
            id: milestone.id,
            description: milestone.description,
          })),
          responsePreview: truncateText(responseContent, 180),
          allowedToolNames,
        },
      });

      const nextResponse = await this.callModelForPhase(ctx, {
        phase,
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        toolChoice: "required",
        budgetReason:
          "Max model recalls exceeded while retrying unfinished request-level execution",
      });
      if (!nextResponse) return "failed";
      ctx.response = nextResponse;
    }

    return retried ? "continue" : "not_required";
  }

  private async finalizeDelegatedTurnAfterToolBudgetExhaustion(
    ctx: ExecutionContext,
    effectiveMaxToolRounds: number,
  ): Promise<boolean> {
    const delegationSpec = ctx.requiredToolEvidence?.delegationSpec;
    if (!delegationSpec || ctx.response?.finishReason !== "tool_calls") {
      return false;
    }

    const requestedToolNames = ctx.response.toolCalls
      .map((toolCall) => toolCall.name?.trim())
      .filter((toolName): toolName is string => Boolean(toolName));
    const instruction = buildDelegatedBudgetFinalizationInstruction({
      acceptanceCriteria: delegationSpec.acceptanceCriteria,
      requestedToolNames,
    });

    this.pushMessage(
      ctx,
      { role: "system", content: instruction },
      "system_runtime",
    );

    const finalResponse = await this.callModelForPhase(ctx, {
      phase: "tool_followup",
      callMessages: ctx.messages,
      callSections: ctx.messageSections,
      onStreamChunk: ctx.activeStreamCallback,
      statefulSessionId: ctx.sessionId,
      statefulResumeAnchor: ctx.stateful?.resumeAnchor,
      statefulHistoryCompacted: ctx.stateful?.historyCompacted,
      routedToolNames: [],
      persistRoutedToolNames: false,
      toolChoice: "none",
      preparationDiagnostics: {
        toolBudgetFinalization: true,
        requestedToolNames,
        recallBudgetBypassed: true,
      },
      allowRecallBudgetBypass: true,
      budgetReason:
        "Max model recalls exceeded while finalizing delegated result after tool budget exhaustion",
    });
    const supersededStopReason =
      ctx.stopReason === "completed" ? undefined : ctx.stopReason;

    if (!finalResponse) {
      this.emitExecutionTrace(ctx, {
        type: "tool_round_budget_finalization_finished",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          outcome: "model_call_unavailable",
          maxToolRounds: effectiveMaxToolRounds,
          requestedToolNames,
          requestedToolCount: requestedToolNames.length,
          ...(supersededStopReason
            ? { supersededStopReason }
            : {}),
        },
      });
      return true;
    }

    ctx.response = finalResponse;
    const {
      contractValidation,
      missingEvidenceMessage,
    } = validateRequiredToolEvidence({ ctx });
    const validationCode = contractValidation?.code;

    if (ctx.response.finishReason === "tool_calls") {
      ctx.validationCode = undefined;
      this.emitExecutionTrace(ctx, {
        type: "tool_round_budget_finalization_finished",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          outcome: "returned_tool_calls",
          finishReason: ctx.response.finishReason,
          maxToolRounds: effectiveMaxToolRounds,
          requestedToolNames,
          requestedToolCount: requestedToolNames.length,
          ...(supersededStopReason
            ? { supersededStopReason }
            : {}),
        },
      });
      this.setStopReason(
        ctx,
        "tool_calls",
        `Reached max tool rounds (${effectiveMaxToolRounds})`,
      );
      return true;
    }

    if (missingEvidenceMessage) {
      ctx.validationCode = validationCode;
      this.emitExecutionTrace(ctx, {
        type: "tool_round_budget_finalization_finished",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          outcome: "validation_error",
          finishReason: ctx.response.finishReason,
          maxToolRounds: effectiveMaxToolRounds,
          requestedToolNames,
          requestedToolCount: requestedToolNames.length,
          validationCode,
          missingEvidenceMessage,
          ...(supersededStopReason
            ? { supersededStopReason }
            : {}),
        },
      });
      this.setStopReason(ctx, "validation_error", missingEvidenceMessage);
      ctx.finalContent = missingEvidenceMessage;
      return true;
    }

    if (supersededStopReason) {
      // Intentional bypass of the setStopReason guard: when the previous
      // tool round was held under a soft stop reason and the follow-up
      // call produced a clean response with no validation error and no
      // tool calls, we roll the stop reason BACK to "completed" so the
      // normal completion flow can proceed. This is the only legitimate
      // forward-to-completed transition path. See setStopReason JSDoc.
      ctx.stopReason = "completed";
      ctx.stopReasonDetail = undefined;
    }
    ctx.validationCode = undefined;
    this.emitExecutionTrace(ctx, {
      type: "tool_round_budget_finalization_finished",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        outcome: "completed",
        finishReason: ctx.response.finishReason,
        maxToolRounds: effectiveMaxToolRounds,
        requestedToolNames,
        requestedToolCount: requestedToolNames.length,
        ...(supersededStopReason
          ? { supersededStopReason }
          : {}),
      },
    });
    return true;
  }

  private enforceLegacyCompletionCompatibilityBeforeFinalization(
    ctx: ExecutionContext,
  ): void {
    if (ctx.stopReason !== "completed") {
      return;
    }
    const workflowContext = resolveRuntimeWorkflowContext({ ctx });
    if (
      workflowContext.verificationContract ||
      workflowContext.completionContract
    ) {
      const ownerClass = resolveWorkflowOwnerClass({
        workflowContext,
        plannerCompletionContract: ctx.plannerCompletionContract,
        plannerVerificationContract: ctx.plannerVerificationContract,
      });
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          gate: "workflow_completion_truth",
          decision:
            ctx.completionState === "completed" ? "accept" : "accept_nonterminal",
          ownerClass,
          completionState: ctx.completionState,
          ownershipSource: workflowContext.ownershipSource,
          reason: "workflow_verification_contract_present",
        },
      });
      return;
    }
    if (ctx.requiredToolEvidence?.delegationSpec) {
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          gate: "legacy_completion_compatibility",
          decision: "not_required",
          reason: "delegated_child_output_contract_present",
        },
      });
      return;
    }
    if (ctx.plannerTerminalFallback) {
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          gate: "workflow_completion_truth",
          decision: "not_required",
          completionState: ctx.completionState,
          reason: ctx.plannerTerminalFallback.reason,
          enforcement: ctx.plannerTerminalFallback.kind,
        },
      });
      return;
    }
    if (
      ctx.plannerSummaryState.subagentVerification.performed === true &&
      ctx.plannerSummaryState.subagentVerification.overall === "pass"
    ) {
      const ownerClass = resolveWorkflowOwnerClass({
        plannerCompletionContract: ctx.plannerCompletionContract,
        plannerVerificationContract: ctx.plannerVerificationContract,
      });
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          gate: "workflow_completion_truth",
          decision:
            ctx.completionState === "completed" ? "accept" : "accept_nonterminal",
          ownerClass,
          completionState: ctx.completionState,
          ownershipSource: "planner_owned",
          reason: "planner_verifier_passed",
        },
      });
      return;
    }

    if (requiresWorkflowOwnedImplementationCompletion({ ctx })) {
      const reason =
        "Implementation-class completion requires workflow-owned verification closure before finalization.";
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          gate: "workflow_completion_truth",
          decision: "fail",
          ownerClass: "implementation",
          completionState: ctx.completionState,
          reason,
        },
      });
      this.setStopReason(ctx, "validation_error", reason);
      ctx.finalContent = reason;
      return;
    }

    const decision = resolveLegacyCompletionCompatibility({ ctx });
    this.emitExecutionTrace(ctx, {
      type: "completion_gate_checked",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        gate: "legacy_completion_compatibility",
        decision: decision.allowed ? "accept" : "fail",
        compatibilityClass: decision.compatibilityClass,
        reason: decision.reason,
      },
    });
    if (decision.allowed) {
      return;
    }
    this.setStopReason(ctx, "validation_error", decision.reason);
    ctx.finalContent = decision.reason;
  }

  private async callModelForPhase(
    ctx: ExecutionContext,
    input: {
      phase: ChatCallUsageRecord["phase"];
      callMessages: readonly LLMMessage[];
      callReconciliationMessages?: readonly LLMMessage[];
      callSections?: readonly PromptBudgetSection[];
      onStreamChunk?: StreamProgressCallback;
      statefulSessionId?: string;
      statefulResumeAnchor?: LLMStatefulResumeAnchor;
      statefulHistoryCompacted?: boolean;
      routedToolNames?: readonly string[];
      persistRoutedToolNames?: boolean;
      toolChoice?: LLMToolChoice;
      structuredOutput?: LLMStructuredOutputRequest;
      preparationDiagnostics?: Record<string, unknown>;
      allowRecallBudgetBypass?: boolean;
      budgetReason: string;
    },
  ): Promise<LLMResponse | undefined> {
    if (!input.allowRecallBudgetBypass && !this.hasModelRecallBudget(ctx)) {
      this.setStopReason(ctx, "budget_exceeded", input.budgetReason);
      return undefined;
    }
    if (this.checkRequestTimeout(ctx, `${input.phase} model call`)) {
      // checkRequestTimeout already routes through setStopReason() which
      // honors the "only transition from completed" guard. The previous
      // direct `ctx.stopReason = "timeout"` assignment here bypassed that
      // guard and could overwrite an earlier authoritative stop reason
      // (audit S1.3).
      return undefined;
    }
    const effectiveRoutedToolNames = resolveEffectiveRoutedToolNames({
      requestedRoutedToolNames: input.routedToolNames,
      hasToolRouting: Boolean(ctx.toolRouting),
      activeRoutedToolNames: ctx.activeRoutedToolNames,
      allowedTools: this.allowedTools ?? undefined,
    });
    const allowStatefulContinuation =
      shouldUseSessionStatefulContinuationForPhase(input.phase);
    if (input.persistRoutedToolNames !== false) {
      applyActiveRoutedToolNames(ctx, effectiveRoutedToolNames);
      ctx.transientRoutedToolNames = undefined;
    } else {
      ctx.transientRoutedToolNames = effectiveRoutedToolNames;
    }
    const compactedCallInput = await this.maybeCompactInFlightCallInput(ctx, {
      callMessages: input.callMessages,
      callReconciliationMessages: input.callReconciliationMessages,
      callSections: input.callSections,
      statefulHistoryCompacted: input.statefulHistoryCompacted,
    });
    const groundingMessage =
      input.phase === "tool_followup" || input.phase === "planner_synthesis"
        ? buildToolExecutionGroundingMessage({
          toolCalls: ctx.allToolCalls,
          providerEvidence: ctx.providerEvidence,
        })
        : undefined;
    const effectiveCallMessages = groundingMessage
      ? [...compactedCallInput.callMessages, groundingMessage]
      : [...compactedCallInput.callMessages];
    const effectiveCallSections =
      groundingMessage && compactedCallInput.callSections
        ? [...compactedCallInput.callSections, "system_runtime" as const]
        : compactedCallInput.callSections;
    const requestedStructuredOutput =
      input.structuredOutput?.enabled === false ||
        input.structuredOutput?.schema === undefined
        ? undefined
        : input.structuredOutput;
    const statefulContinuationRequired =
      allowStatefulContinuation &&
      Boolean(input.statefulSessionId) &&
      (
        input.phase === "tool_followup" ||
        Boolean(input.statefulResumeAnchor) ||
        compactedCallInput.statefulHistoryCompacted === true ||
        ctx.history.length > 0
      );
    let routingDecision: ReturnType<ChatExecutor["resolveRoutingDecision"]>;
    try {
      routingDecision = this.resolveRoutingDecision(ctx, input.phase, {
        statefulContinuationRequired,
        structuredOutputRequired: requestedStructuredOutput !== undefined,
        routedToolNames: effectiveRoutedToolNames,
      });
    } catch (error) {
      const annotated = annotateFailureError(
        error,
        `${input.phase} routing preflight`,
      );
      this.setStopReason(ctx, annotated.stopReason, annotated.stopReasonDetail);
      throw annotated.error;
    }
    const parallelToolCalls = resolveParallelToolCallPolicy({
      policy: this.modelRoutingPolicy,
      selectedProviderName: routingDecision.route.selectedProviderName,
      selectedProviderRouteKey: routingDecision.route.selectedProviderRouteKey,
      phase: input.phase,
    });
    const disableStreaming =
      ctx.plannerDecision.reason === "concordia_generate_agents_turn" ||
      ctx.plannerDecision.reason === "exact_response_turn" ||
      ctx.plannerDecision.reason === "dialogue_memory_turn";
    const structuredOutput =
      requestedStructuredOutput &&
      routingDecision.route.selectedProviderName === "grok"
        ? requestedStructuredOutput
        : undefined;
    if (
      this.economicsPolicy.mode === "enforce" &&
      routingDecision.pressure.hardExceeded
    ) {
      this.setStopReason(
        ctx,
        "budget_exceeded",
        `${routingDecision.runClass} budget ceiling reached before ${input.phase} model call`,
      );
      return undefined;
    }
    this.emitExecutionTrace(ctx, {
      type: "model_call_prepared",
      phase: input.phase,
      callIndex: ctx.callIndex + 1,
      payload: {
        ...(input.routedToolNames !== undefined
          ? { requestedRoutedToolNames: input.routedToolNames }
          : {}),
        ...(input.preparationDiagnostics ?? {}),
        routedToolNames: effectiveRoutedToolNames ?? [],
        activeRecoveryHintKeys: ctx.activeRecoveryHintKeys,
        remainingRequestMs: this.serializeRemainingRequestMs(
          this.getRemainingRequestMs(ctx),
        ),
        effectiveRequestTimeoutMs: this.serializeRequestTimeoutMs(
          ctx.effectiveRequestTimeoutMs,
        ),
        toolChoice:
          input.toolChoice === undefined
            ? undefined
            : typeof input.toolChoice === "string"
            ? input.toolChoice
            : input.toolChoice.name,
        parallelToolCalls,
        structuredOutputSchemaName: structuredOutput?.schema?.name,
        messageCount: effectiveCallMessages.length,
        groundingMessageAdded: Boolean(groundingMessage),
        activeRouteMisses: ctx.routedToolMisses,
        routedToolsExpanded: ctx.routedToolsExpanded,
        economicsRunClass: routingDecision.runClass,
        providerRoute: routingDecision.route.providers.map((provider) =>
          getProviderRouteKey(provider)
        ),
        providerRouteReason: routingDecision.route.reason,
        budgetPressure: {
          tokenRatio: Number(routingDecision.pressure.tokenRatio.toFixed(4)),
          latencyRatio: Number(routingDecision.pressure.latencyRatio.toFixed(4)),
          spendRatio: Number(routingDecision.pressure.spendRatio.toFixed(4)),
          hardExceeded: routingDecision.pressure.hardExceeded,
          downgraded: routingDecision.route.downgraded,
        },
      },
    });
    let next: FallbackResult;
    try {
      next = await this.callWithFallback(
        effectiveCallMessages,
        input.onStreamChunk,
        effectiveCallSections,
        {
          requestDeadlineAt: ctx.requestDeadlineAt,
          signal: ctx.signal,
          ...(allowStatefulContinuation && input.statefulSessionId
            ? {
              statefulSessionId: input.statefulSessionId,
              reconciliationMessages:
                compactedCallInput.callReconciliationMessages ??
                ctx.reconciliationMessages,
              ...(compactedCallInput.statefulHistoryCompacted
                ? { statefulHistoryCompacted: true }
                : {}),
              ...(input.statefulResumeAnchor
                ? { statefulResumeAnchor: input.statefulResumeAnchor }
                : {}),
            }
            : {}),
          ...(effectiveRoutedToolNames !== undefined
            ? { routedToolNames: effectiveRoutedToolNames }
            : {}),
          ...(input.toolChoice !== undefined
            ? { toolChoice: input.toolChoice }
            : {}),
          parallelToolCalls,
          ...(structuredOutput !== undefined
            ? { structuredOutput }
            : {}),
          ...(ctx.trace
            ? {
              trace: ctx.trace,
              callIndex: ctx.callIndex + 1,
              callPhase: input.phase,
            }
            : {}),
          ...(disableStreaming ? { disableStreaming: true } : {}),
          providersOverride: routingDecision.route.providers,
        },
      );
    } catch (error) {
      const annotated = annotateFailureError(
        error,
        `${input.phase} model call`,
      );
      this.setStopReason(ctx, annotated.stopReason, annotated.stopReasonDetail);
      throw annotated.error;
    }
    ctx.modelCalls++;
    ctx.providerName = next.providerName;
    ctx.responseModel = next.response.model;
    ctx.providerEvidence = mergeProviderEvidence(
      ctx.providerEvidence,
      next.response.providerEvidence,
    );
    if (next.usedFallback) ctx.usedFallback = true;
    this.accumulateUsage(ctx.cumulativeUsage, next.response.usage);
    this.trackTokenUsage(ctx.sessionId, next.response.usage.totalTokens);
    recordRuntimeModelCall({
      policy: this.economicsPolicy,
      state: ctx.economicsState,
      runClass: routingDecision.runClass,
      provider: next.providerName,
      model: next.response.model,
      usage: next.response.usage,
      durationMs: next.durationMs,
      rerouted: routingDecision.route.rerouted || next.usedFallback,
      downgraded: routingDecision.route.downgraded,
      phase: input.phase,
      reason: routingDecision.route.reason,
    });
    ctx.delegationBudgetSnapshot = buildDelegationBudgetSnapshot(
      this.economicsPolicy,
      ctx.economicsState,
    );
    ctx.callUsage.push(
      this.createCallUsageRecord({
        callIndex: ++ctx.callIndex,
        phase: input.phase,
        providerName: next.providerName,
        response: next.response,
        durationMs: next.durationMs,
        beforeBudget: next.beforeBudget,
        afterBudget: next.afterBudget,
        budgetDiagnostics: next.budgetDiagnostics,
      }),
    );
    return next.response;
  }

  private async runPipelineWithTimeout(
    ctx: ExecutionContext,
    pipeline: Pipeline,
  ): Promise<PipelineResult | undefined> {
    ctx.plannerFailedStep = undefined;
    const remainingMs = this.getRemainingRequestMs(ctx);
    if (!Number.isFinite(remainingMs)) {
      return this.pipelineExecutor!.execute(
        pipeline,
        0,
        {
          ...(ctx.activeToolHandler
            ? { toolHandler: ctx.activeToolHandler }
            : {}),
          onEvent: (event) => this.emitPipelineExecutionTrace(ctx, event),
        },
      );
    }
    if (remainingMs <= 0) {
      this.setStopReason(
        ctx,
        "timeout",
        this.timeoutDetail("planner pipeline execution", ctx.effectiveRequestTimeoutMs),
      );
      return undefined;
    }
    const timeoutMessage = `planner pipeline timed out after ${remainingMs}ms`;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, remainingMs);
    });
    try {
      return await Promise.race([
        this.pipelineExecutor!.execute(
          pipeline,
          0,
          {
            ...(ctx.activeToolHandler
              ? { toolHandler: ctx.activeToolHandler }
              : {}),
            onEvent: (event) => this.emitPipelineExecutionTrace(ctx, event),
          },
        ),
        timeoutPromise,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === timeoutMessage) {
        this.setStopReason(
          ctx,
          "timeout",
          this.timeoutDetail("planner pipeline execution", ctx.effectiveRequestTimeoutMs),
        );
        return undefined;
      }
      const annotated = annotateFailureError(
        error,
        "planner pipeline execution",
      );
      this.setStopReason(ctx, annotated.stopReason, annotated.stopReasonDetail);
      throw annotated.error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async initializeExecutionContext(
    params: ChatExecuteParams,
  ): Promise<ExecutionContext> {
    const { message, systemPrompt, sessionId, signal } = params;
    let { history } = params;
    const effectiveMaxToolRounds =
      typeof params.maxToolRounds === "number" && Number.isFinite(params.maxToolRounds)
        ? normalizeRuntimeLimit(params.maxToolRounds, this.maxToolRounds)
        : this.maxToolRounds;
    const effectiveToolBudget =
      typeof params.toolBudgetPerRequest === "number" &&
        Number.isFinite(params.toolBudgetPerRequest)
        ? normalizeRuntimeLimit(
            params.toolBudgetPerRequest,
            this.toolBudgetPerRequest,
          )
        : this.toolBudgetPerRequest;
    const effectiveMaxModelRecalls =
      typeof params.maxModelRecallsPerRequest === "number" &&
        Number.isFinite(params.maxModelRecallsPerRequest)
        ? normalizeRuntimeLimit(
            params.maxModelRecallsPerRequest,
            this.maxModelRecallsPerRequest,
          )
        : this.maxModelRecallsPerRequest;
    const messageText = extractMessageText(message);
    const initialRoutedToolNames = params.toolRouting?.routedToolNames
      ? Array.from(new Set(params.toolRouting.routedToolNames))
      : [];
    const expandedRoutedToolNames = params.toolRouting?.expandedToolNames
      ? Array.from(new Set(params.toolRouting.expandedToolNames))
      : [];
    const explicitRequirementToolNames =
      mergeExplicitRequirementToolNames(
        initialRoutedToolNames,
        expandedRoutedToolNames,
        this.allowedTools ? [...this.allowedTools] : [],
      );
    const explicitDeterministicToolRequirements =
      extractExplicitDeterministicToolRequirements(
        messageText,
        explicitRequirementToolNames,
        message.metadata,
      );
    const explicitSubagentOrchestrationRequirements =
      extractExplicitSubagentOrchestrationRequirements(messageText);
    const isConcordiaTurnMessage = isConcordiaSimulationTurnMessage(message);
    const turnExecutionContract = resolveTurnExecutionContract({
      message,
      runtimeContext: {
        ...(params.runtimeContext ?? {}),
        workspaceRoot:
          params.runtimeContext?.workspaceRoot ??
          this.resolveHostWorkspaceRoot?.() ??
          undefined,
      },
      requiredToolEvidence: params.requiredToolEvidence,
    });
    const explicitArtifactTaskContract = turnExecutionContract.artifactTaskContract;
    const directArtifactOwner =
      explicitArtifactTaskContract?.delegationPolicy === "direct_owner";
    const groundedExecutionRequested =
      !isConcordiaTurnMessage &&
      turnExecutionContract.turnClass === "workflow_implementation" &&
      requestRequiresToolGroundedExecution(messageText);
    let plannerDecision = directArtifactOwner
      ? {
          score: 4,
          shouldPlan: false,
          reason: "direct_artifact_owner_update",
          artifactTargets: explicitArtifactTaskContract?.targetArtifacts,
        }
      : assessPlannerDecision(
          this.plannerEnabled,
          messageText,
          history,
          params.message.metadata,
        );
    if (
      !isConcordiaTurnMessage &&
      !directArtifactOwner &&
      explicitDeterministicToolRequirements?.forcePlanner &&
      !plannerDecision.shouldPlan
    ) {
      plannerDecision = {
        score: Math.max(plannerDecision.score, 3),
        shouldPlan: true,
        reason: "explicit_deterministic_tool_requirements",
      };
    }
    if (
      !isConcordiaTurnMessage &&
      !directArtifactOwner &&
      !plannerDecision.shouldPlan &&
      explicitSubagentOrchestrationRequirements
    ) {
      plannerDecision = {
        score: Math.max(plannerDecision.score, 4),
        shouldPlan: true,
        reason: "explicit_subagent_orchestration_requirements",
      };
    }
    if (!plannerDecision.shouldPlan && groundedExecutionRequested) {
      plannerDecision = {
        score: Math.max(plannerDecision.score, 4),
        shouldPlan: true,
        reason: "grounded_execution_request",
      };
    }
    const resolvedThresholdOverride = this.resolveDelegationScoreThreshold?.();
    const baseDelegationThreshold =
      typeof resolvedThresholdOverride === "number" &&
        Number.isFinite(resolvedThresholdOverride)
        ? Math.max(0, Math.min(1, resolvedThresholdOverride))
        : this.delegationDecisionConfig.scoreThreshold;

    // Pre-check token budget — attempt compaction instead of hard fail
    let compacted = false;
    let compactedArtifactContext = params.stateful?.artifactContext;
    const compactionState = this.getSessionCompactionState(sessionId);
    if (
      compactionState.hardBudgetReached || compactionState.softThresholdReached
    ) {
      const cooldownSnapshot = compactionState.hardBudgetReached
        ? undefined
        : new Map(this.cooldowns);
      try {
        const compactedResult = await this.compactHistory(
          history,
          sessionId,
          params.trace,
          params.stateful?.artifactContext,
        );
        history = compactedResult.history;
        compactedArtifactContext = compactedResult.artifactContext;
        this.resetSessionTokens(sessionId);
        compacted = true;
      } catch {
        if (compactionState.hardBudgetReached) {
          throw new ChatBudgetExceededError(
            sessionId,
            compactionState.used,
            this.sessionTokenBudget!,
          );
        }
        if (cooldownSnapshot) {
          this.cooldowns.clear();
          for (const [providerName, cooldown] of cooldownSnapshot.entries()) {
            this.cooldowns.set(providerName, cooldown);
          }
        }
      }
    }

    const resolvedRequiredToolEvidence = mergeTurnExecutionRequiredToolEvidence({
      base: params.requiredToolEvidence,
      turnExecutionContract,
    });

    const ctx = buildDefaultExecutionContext(
      {
        message,
        messageText,
        systemPrompt,
        sessionId,
        runtimeContext: params.runtimeContext,
        turnExecutionContract,
        signal,
        history,
        plannerDecision,
        compacted,
        toolHandler: params.toolHandler ?? this.toolHandler,
        streamCallback: params.onStreamChunk ?? this.onStreamChunk,
        toolRouting: params.toolRouting,
        stateful:
          params.stateful || compactedArtifactContext
            ? {
                ...params.stateful,
                ...(compacted ? { historyCompacted: true } : {}),
                ...(compactedArtifactContext
                  ? { artifactContext: compactedArtifactContext }
                  : {}),
              }
            : undefined,
        trace: params.trace,
        requiredToolEvidence: resolvedRequiredToolEvidence,
        initialRoutedToolNames,
        expandedRoutedToolNames,
        baseDelegationThreshold,
      },
      {
        maxToolRounds: effectiveMaxToolRounds,
        toolBudgetPerRequest: effectiveToolBudget,
        maxModelRecallsPerRequest: effectiveMaxModelRecalls,
        maxFailureBudgetPerRequest: this.maxFailureBudgetPerRequest,
        requestTimeoutMs: ChatExecutor.normalizeRequestTimeoutMs(
          params.requestTimeoutMs ?? this.requestTimeoutMs,
        ),
        providerName: this.providers[0]?.name ?? "unknown",
        plannerEnabled: this.plannerEnabled,
        subagentVerifierEnabled: this.subagentVerifierConfig.enabled,
        delegationBanditTunerEnabled: Boolean(this.delegationBanditTuner),
        delegationScoreThreshold: this.delegationDecisionConfig.scoreThreshold,
        defaultRunClass: this.defaultRunClass,
        economicsPolicy: this.economicsPolicy,
      },
    );

    if (turnExecutionContract.invalidReason) {
      ctx.plannerHandled = true;
      this.setStopReason(ctx, "validation_error", turnExecutionContract.invalidReason);
      ctx.finalContent = turnExecutionContract.invalidReason;
      return ctx;
    }

    // Build messages array with explicit section tags for prompt budgeting.
    this.pushMessage(ctx, { role: "system", content: ctx.systemPrompt }, "system_anchor");

    const isConcordiaTurn = isConcordiaTurnMessage;
    const enableSkillContext =
      params.contextInjection?.skills !== false && !isConcordiaTurn;
    const enableIdentityContext = !isConcordiaTurn;
    const enableMemoryContext =
      params.contextInjection?.memory !== false && !isConcordiaTurn;

    // Context injection — skill, identity, memory, and learning (all best-effort)
    if (enableSkillContext) {
      await this.injectContext(
        ctx,
        this.skillInjector,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "system_runtime",
      );
    }
    // Phase 5.4: inject agent identity (personality, beliefs, traits) after skills
    // but before memory/learning so the agent's persona frames retrieved context.
    // Identity is always injected (not gated on hasHistory) since it defines who the agent is.
    if (enableIdentityContext && this.identityProvider) {
      await this.injectContext(
        ctx,
        this.identityProvider,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "system_runtime",
      );
    }
    // Persistent semantic memory (workspace-scoped, cross-session) is always
    // injected — it provides facts learned in prior sessions (e.g. user's name).
    // The retriever handles its own scoping: working memory is session-scoped,
    // semantic/episodic memory is workspace-scoped with maxAge filtering.
    if (enableMemoryContext && ctx.hasHistory) {
      await this.injectContext(
        ctx,
        this.memoryRetriever,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_semantic",
      );
    }
    // Session-scoped providers (learning patterns, progress tracker) are gated
    // on hasHistory since they rely on current-session context and should not
    // inject stale session state into a truly fresh first turn.
    if (enableMemoryContext && ctx.hasHistory) {
      await this.injectContext(
        ctx,
        this.learningProvider,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_episodic",
      );
      await this.injectContext(
        ctx,
        this.progressProvider,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_working",
      );
    }

    if (ctx.stateful?.artifactContext?.artifactRefs?.length) {
      const artifactLines = selectRelevantArtifactRefs({
        artifacts: ctx.stateful.artifactContext.artifactRefs,
        query: ctx.messageText,
        maxChars: Math.max(
          600,
          Math.floor(
            (this.promptBudget.hardMaxPromptChars ?? MAX_PROMPT_CHARS_BUDGET) *
              0.08,
          ),
        ),
      });
      if (artifactLines.length > 0) {
        this.pushMessage(
          ctx,
          {
            role: "system",
            content: `Compacted artifact context:\n${artifactLines
              .map((line) => `- ${line}`)
              .join("\n")}`,
          },
          "memory_working",
        );
      }
    }

    // Append history and user message
    const normalizedHistory = normalizeHistory(ctx.history);
    const reconciliationHistory =
      normalizeHistoryForStatefulReconciliation(ctx.history);
    for (let index = 0; index < normalizedHistory.length; index++) {
      this.pushMessage(
        ctx,
        normalizedHistory[index]!,
        "history",
        reconciliationHistory[index],
      );
    }

    appendUserMessage(
      ctx.messages,
      ctx.messageSections,
      ctx.message,
      ctx.reconciliationMessages,
    );

    return ctx;
  }

  private async maybeCompactInFlightCallInput(
    ctx: ExecutionContext,
    input: {
      readonly callMessages: readonly LLMMessage[];
      readonly callReconciliationMessages?: readonly LLMMessage[];
      readonly callSections?: readonly PromptBudgetSection[];
      readonly statefulHistoryCompacted?: boolean;
    },
  ): Promise<{
    readonly callMessages: readonly LLMMessage[];
    readonly callReconciliationMessages?: readonly LLMMessage[];
    readonly callSections?: readonly PromptBudgetSection[];
    readonly statefulHistoryCompacted: boolean;
  }> {
    const compactionState = this.getSessionCompactionState(ctx.sessionId);
    const statefulHistoryCompacted =
      input.statefulHistoryCompacted === true || ctx.compacted;
    if (
      !compactionState.hardBudgetReached &&
      !compactionState.softThresholdReached
    ) {
      return {
        callMessages: input.callMessages,
        callReconciliationMessages: input.callReconciliationMessages,
        callSections: input.callSections,
        statefulHistoryCompacted,
      };
    }

    const usesLiveExecutionMessages =
      input.callMessages === ctx.messages &&
      (
        input.callSections === undefined ||
        input.callSections === ctx.messageSections
      ) &&
      (
        input.callReconciliationMessages === undefined ||
        input.callReconciliationMessages === ctx.reconciliationMessages
      );
    if (!usesLiveExecutionMessages) {
      if (compactionState.hardBudgetReached) {
        throw new ChatBudgetExceededError(
          ctx.sessionId,
          compactionState.used,
          this.sessionTokenBudget!,
        );
      }
      return {
        callMessages: input.callMessages,
        callReconciliationMessages: input.callReconciliationMessages,
        callSections: input.callSections,
        statefulHistoryCompacted,
      };
    }

    const replayTailStartIndex = this.findInFlightCompactionTailStartIndex(
      input.callMessages,
      input.callSections,
    );
    const replayTail = input.callMessages.slice(replayTailStartIndex);
    const inFlightKeepTailCount = 3;
    if (replayTail.length <= inFlightKeepTailCount) {
      if (compactionState.hardBudgetReached) {
        throw new ChatBudgetExceededError(
          ctx.sessionId,
          compactionState.used,
          this.sessionTokenBudget!,
        );
      }
      return {
        callMessages: input.callMessages,
        callReconciliationMessages: input.callReconciliationMessages,
        callSections: input.callSections,
        statefulHistoryCompacted,
      };
    }

    const cooldownSnapshot = compactionState.hardBudgetReached
      ? undefined
      : new Map(this.cooldowns);
    try {
      const compacted = await this.compactHistory(
        replayTail,
        ctx.sessionId,
        ctx.trace,
        ctx.compactedArtifactContext,
        inFlightKeepTailCount,
      );
      const retainedTailCount = Math.max(0, compacted.history.length - 1);
      const replayTailReconciliationMessages = (
        input.callReconciliationMessages ?? ctx.reconciliationMessages
      ).slice(replayTailStartIndex);
      const replayTailSections = (
        input.callSections ?? ctx.messageSections
      ).slice(replayTailStartIndex);
      const compactedReconciliationMessages: readonly LLMMessage[] = [
        {
          role: "system",
          content:
            typeof compacted.history[0]?.content === "string"
              ? compacted.history[0].content
              : "",
        },
        ...replayTailReconciliationMessages.slice(-retainedTailCount),
      ];
      const compactedSections: readonly PromptBudgetSection[] = [
        "memory_working",
        ...replayTailSections.slice(-retainedTailCount),
      ];
      const nextMessages = [
        ...input.callMessages.slice(0, replayTailStartIndex),
        ...compacted.history,
      ];
      const nextReconciliationMessages = [
        ...(input.callReconciliationMessages ?? ctx.reconciliationMessages).slice(
          0,
          replayTailStartIndex,
        ),
        ...compactedReconciliationMessages,
      ];
      const nextSections = [
        ...(input.callSections ?? ctx.messageSections).slice(
          0,
          replayTailStartIndex,
        ),
        ...compactedSections,
      ];
      ctx.messages = [...nextMessages];
      ctx.reconciliationMessages = [...nextReconciliationMessages];
      ctx.messageSections = [...nextSections];
      ctx.compacted = true;
      ctx.compactedArtifactContext = compacted.artifactContext;
      this.resetSessionTokens(ctx.sessionId);
      return {
        callMessages: ctx.messages,
        callReconciliationMessages: ctx.reconciliationMessages,
        callSections: ctx.messageSections,
        statefulHistoryCompacted: true,
      };
    } catch (error) {
      if (compactionState.hardBudgetReached) {
        if (error instanceof ChatBudgetExceededError) {
          throw error;
        }
        throw new ChatBudgetExceededError(
          ctx.sessionId,
          compactionState.used,
          this.sessionTokenBudget!,
        );
      }
      if (cooldownSnapshot) {
        this.cooldowns.clear();
        for (const [providerName, cooldown] of cooldownSnapshot.entries()) {
          this.cooldowns.set(providerName, cooldown);
        }
      }
      return {
        callMessages: input.callMessages,
        callReconciliationMessages: input.callReconciliationMessages,
        callSections: input.callSections,
        statefulHistoryCompacted,
      };
    }
  }

  private findInFlightCompactionTailStartIndex(
    messages: readonly LLMMessage[],
    sections?: readonly PromptBudgetSection[],
  ): number {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (
        sections?.[index] === "user" ||
        messages[index]?.role === "user"
      ) {
        return index + 1;
      }
    }
    return messages.length;
  }

  private recordOutcomeAndFinalize(ctx: ExecutionContext): {
    plannerSummary: ChatPlannerSummary;
    durationMs: number;
  } {
    const durationMs = Date.now() - ctx.startTime;
    const verifierSnapshot = ctx.plannerSummaryState.subagentVerification;
    const qualityProxy = computeQualityProxy({
      completionState: ctx.completionState,
      verifierPerformed: verifierSnapshot.performed,
      verifierOverall: verifierSnapshot.overall,
      evaluation: ctx.evaluation,
      failedToolCalls: ctx.failedToolCalls,
    });
    const rewardSignal = computeDelegationFinalReward({
      qualityProxy,
      tokenCost: ctx.cumulativeUsage.totalTokens,
      latencyMs: durationMs,
      errorCount:
        ctx.failedToolCalls + (ctx.completionState === "completed" ? 0 : 1),
    });
    const estimatedRecallsAvoided = ctx.plannerSummaryState.used
      ? Math.max(
          0,
          ctx.plannerSummaryState.deterministicStepsExecuted -
            Math.max(0, ctx.modelCalls - ctx.plannerSummaryState.plannerCalls),
        )
      : 0;
    const delegatedThisTurn =
      ctx.plannerSummaryState.delegationDecision?.shouldDelegate === true;
    const usefulnessProxy = computeUsefulDelegationProxy({
      delegated: delegatedThisTurn,
      completionState: ctx.completionState,
      failedToolCalls: ctx.failedToolCalls,
      estimatedRecallsAvoided,
      verifier: {
        performed: verifierSnapshot.performed,
        overall: verifierSnapshot.overall,
        confidence: verifierSnapshot.confidence,
      },
      reward: rewardSignal,
    });
    const policyReward = delegatedThisTurn
      ? usefulnessProxy.score * 2 - 1
      : 0;

    if (
      ctx.selectedBanditArm &&
      this.delegationBanditTuner &&
      ctx.plannerSummaryState.delegationPolicyTuning.enabled
    ) {
      this.delegationBanditTuner.recordOutcome({
        contextClusterId: ctx.trajectoryContextClusterId,
        armId: ctx.selectedBanditArm.armId,
        reward: policyReward,
      });
      ctx.plannerSummaryState.delegationPolicyTuning = {
        ...ctx.plannerSummaryState.delegationPolicyTuning,
        finalReward: policyReward,
        usefulDelegation: usefulnessProxy.useful,
        usefulDelegationScore: usefulnessProxy.score,
        rewardProxyVersion: DELEGATION_USEFULNESS_PROXY_VERSION,
      };
    }

    if (this.delegationTrajectorySink) {
      const selectedTools = ctx.activeRoutedToolNames.length > 0
        ? [...ctx.activeRoutedToolNames]
        : (this.allowedTools ? [...this.allowedTools] : []);
      this.delegationTrajectorySink.record(
        buildDelegationTrajectoryEntry({
          ctx,
          qualityProxy,
          durationMs,
          rewardSignal,
          usefulnessProxy,
          selectedTools,
          defaultStrategyArmId: this.delegationDefaultStrategyArmId,
          delegationMaxDepth: this.delegationDecisionConfig.maxDepth,
          delegationMaxFanoutPerTurn: this.delegationDecisionConfig.maxFanoutPerTurn,
          requestTimeoutMs: this.requestTimeoutMs,
          usefulDelegationProxyVersion: DELEGATION_USEFULNESS_PROXY_VERSION,
        }),
      );
    }

    const plannerSummary = buildPlannerSummary(
      ctx.plannerSummaryState,
      estimatedRecallsAvoided,
    );

    return { plannerSummary, durationMs };
  }

  private getSessionCompactionState(sessionId: string): {
    readonly used: number;
    readonly hardBudgetReached: boolean;
    readonly softThresholdReached: boolean;
  } {
    const used = this.sessionTokens.get(sessionId) ?? 0;
    return {
      used,
      hardBudgetReached: isRuntimeLimitReached(used, this.sessionTokenBudget),
      softThresholdReached:
        hasRuntimeLimit(this.sessionCompactionThreshold) &&
        isRuntimeLimitReached(used, this.sessionCompactionThreshold),
    };
  }

  private async evaluateAndRetryResponse(ctx: ExecutionContext): Promise<void> {
    const minScore = this.evaluator!.minScore ?? 0.7;
    const maxRetries = this.evaluator!.maxRetries ?? 1;
    let retryCount = 0;
    let currentContent = ctx.finalContent;

    while (retryCount <= maxRetries) {
      if (this.checkRequestTimeout(ctx, "response evaluation")) {
        break;
      }
      // Skip evaluation if token budget would be exceeded.
      if (hasRuntimeLimit(this.sessionTokenBudget)) {
        const used = this.sessionTokens.get(ctx.sessionId) ?? 0;
        if (isRuntimeLimitReached(used, this.sessionTokenBudget)) break;
      }
      if (!this.hasModelRecallBudget(ctx)) {
        this.setStopReason(
          ctx,
          "budget_exceeded",
          "Max model recalls exceeded during response evaluation",
        );
        break;
      }

      const evalResult = await this.evaluateResponse(
        ctx,
        currentContent,
        ctx.messageText,
        ctx.trace,
        ctx.callIndex + 1,
      );
      ctx.modelCalls++;
      if (evalResult.usedFallback) ctx.usedFallback = true;
      this.accumulateUsage(ctx.cumulativeUsage, evalResult.response.usage);
      this.trackTokenUsage(ctx.sessionId, evalResult.response.usage.totalTokens);
      recordRuntimeModelCall({
        policy: this.economicsPolicy,
        state: ctx.economicsState,
        runClass: this.resolveRunClassForPhase(ctx, "evaluator"),
        provider: evalResult.providerName,
        model: evalResult.response.model,
        usage: evalResult.response.usage,
        durationMs: evalResult.durationMs,
        rerouted: evalResult.rerouted,
        downgraded: evalResult.downgraded,
        phase: "evaluator",
        reason: evalResult.routeReason,
      });
      ctx.delegationBudgetSnapshot = buildDelegationBudgetSnapshot(
        this.economicsPolicy,
        ctx.economicsState,
      );
      ctx.callUsage.push(
        this.createCallUsageRecord({
          callIndex: ++ctx.callIndex,
          phase: "evaluator",
          providerName: evalResult.providerName,
          response: evalResult.response,
          durationMs: evalResult.durationMs,
          beforeBudget: evalResult.beforeBudget,
          afterBudget: evalResult.afterBudget,
          budgetDiagnostics: evalResult.budgetDiagnostics,
        }),
      );

      if (evalResult.score >= minScore || retryCount === maxRetries) {
        ctx.evaluation = {
          score: evalResult.score,
          feedback: evalResult.feedback,
          passed: evalResult.score >= minScore,
          retryCount,
        };
        ctx.finalContent = currentContent;
        break;
      }

      retryCount++;
      this.pushMessage(
        ctx,
        { role: "assistant", content: currentContent, phase: "commentary" },
        "assistant_runtime",
      );
      this.pushMessage(
        ctx,
        {
          role: "system",
          content: `Response scored ${evalResult.score.toFixed(2)}. Feedback: ${evalResult.feedback}\nPlease improve your response.`,
        },
        "system_runtime",
      );

      if (!this.hasModelRecallBudget(ctx)) {
        this.setStopReason(
          ctx,
          "budget_exceeded",
          "Max model recalls exceeded during evaluator retry",
        );
        break;
      }
      if (this.checkRequestTimeout(ctx, "evaluator retry")) {
        break;
      }
      const retryRoutingDecision = this.resolveRoutingDecision(
        ctx,
        "evaluator_retry",
      );
      let retry: FallbackResult;
      try {
        retry = await this.callWithFallback(
          ctx.messages,
          ctx.activeStreamCallback,
          ctx.messageSections,
          {
            statefulSessionId: ctx.sessionId,
            statefulResumeAnchor: ctx.stateful?.resumeAnchor,
            statefulHistoryCompacted: ctx.stateful?.historyCompacted,
            reconciliationMessages: ctx.reconciliationMessages,
            ...(ctx.toolRouting
              ? { routedToolNames: ctx.activeRoutedToolNames }
              : {}),
            ...(ctx.trace
              ? {
                trace: ctx.trace,
                callIndex: ctx.callIndex + 1,
                callPhase: "evaluator_retry" as const,
              }
              : {}),
            providersOverride: retryRoutingDecision.route.providers,
          },
        );
      } catch (error) {
        const annotated = annotateFailureError(
          error,
          "evaluator retry",
        );
        this.setStopReason(ctx, annotated.stopReason, annotated.stopReasonDetail);
        throw annotated.error;
      }
      ctx.modelCalls++;
      this.accumulateUsage(ctx.cumulativeUsage, retry.response.usage);
      this.trackTokenUsage(ctx.sessionId, retry.response.usage.totalTokens);
      recordRuntimeModelCall({
        policy: this.economicsPolicy,
        state: ctx.economicsState,
        runClass: this.resolveRunClassForPhase(ctx, "evaluator_retry"),
        provider: retry.providerName,
        model: retry.response.model,
        usage: retry.response.usage,
        durationMs: retry.durationMs,
        rerouted: retryRoutingDecision.route.rerouted || retry.usedFallback,
        downgraded: retryRoutingDecision.route.downgraded,
        phase: "evaluator_retry",
        reason: retryRoutingDecision.route.reason,
      });
      ctx.delegationBudgetSnapshot = buildDelegationBudgetSnapshot(
        this.economicsPolicy,
        ctx.economicsState,
      );
      ctx.callUsage.push(
        this.createCallUsageRecord({
          callIndex: ++ctx.callIndex,
          phase: "evaluator_retry",
          providerName: retry.providerName,
          response: retry.response,
          durationMs: retry.durationMs,
          beforeBudget: retry.beforeBudget,
          afterBudget: retry.afterBudget,
          budgetDiagnostics: retry.budgetDiagnostics,
        }),
      );
      ctx.providerName = retry.providerName;
      ctx.responseModel = retry.response.model;
      if (retry.usedFallback) ctx.usedFallback = true;
      currentContent = retry.response.content || currentContent;
    }
  }

  private buildToolLoopCallbacks() {
    return {
      pushMessage: (c: ExecutionContext, msg: LLMMessage, section: PromptBudgetSection, reconciliation?: LLMMessage) =>
        this.pushMessage(c, msg, section, reconciliation),
      setStopReason: (c: ExecutionContext, reason: LLMPipelineStopReason, detail?: string) =>
        this.setStopReason(c, reason, detail),
      checkRequestTimeout: (c: ExecutionContext, stage: string) =>
        this.checkRequestTimeout(c, stage),
      appendToolRecord: (c: ExecutionContext, record: ToolCallRecord) =>
        this.appendToolRecord(c, record),
      emitExecutionTrace: (c: ExecutionContext, event: ChatExecutionTraceEvent) =>
        this.emitExecutionTrace(c, event),
      replaceRuntimeRecoveryHintMessages: (c: ExecutionContext, hints: readonly { key: string }[]) =>
        this.replaceRuntimeRecoveryHintMessages(c, hints),
      maybePushRuntimeInstruction: (c: ExecutionContext, content: string) =>
        this.maybePushRuntimeInstruction(c, content),
      resolveActiveToolContractGuidance: (c: ExecutionContext, input?: Parameters<ChatExecutor["resolveActiveToolContractGuidance"]>[1]) =>
        this.resolveActiveToolContractGuidance(c, input),
      enforceRequiredToolEvidenceBeforeCompletion: (c: ExecutionContext, phase: "initial" | "tool_followup") =>
        this.enforceRequiredToolEvidenceBeforeCompletion(c, phase),
      enforcePlanOnlyExecutionBeforeCompletion: (c: ExecutionContext, phase: "initial" | "tool_followup") =>
        this.enforcePlanOnlyExecutionBeforeCompletion(c, phase),
      enforceWorkflowContinuationBeforeCompletion: (c: ExecutionContext, phase: "initial" | "tool_followup") =>
        this.enforceWorkflowContinuationBeforeCompletion(c, phase),
      finalizeDelegatedTurnAfterToolBudgetExhaustion: (c: ExecutionContext, maxRounds: number) =>
        this.finalizeDelegatedTurnAfterToolBudgetExhaustion(c, maxRounds),
      callModelForPhase: (c: ExecutionContext, input: Parameters<ChatExecutor["callModelForPhase"]>[1]) =>
        this.callModelForPhase(c, input),
      evaluateToolRoundBudgetExtension: (params: Parameters<ChatExecutor["evaluateToolRoundBudgetExtension"]>[0]) =>
        this.evaluateToolRoundBudgetExtension(params),
      serializeRemainingRequestMs: (ms: number) =>
        this.serializeRemainingRequestMs(ms),
    };
  }

  private async executeToolCallLoop(ctx: ExecutionContext): Promise<void> {
    return executeToolCallLoopFn(ctx, {
      maxRuntimeSystemHints: this.maxRuntimeSystemHints,
      toolCallTimeoutMs: this.toolCallTimeoutMs,
      retryPolicyMatrix: this.retryPolicyMatrix,
      allowedTools: this.allowedTools,
      toolFailureBreaker: this.toolFailureBreaker,
    }, this.buildToolLoopCallbacks());
  }

  private async executePlannerPath(ctx: ExecutionContext): Promise<void> {
    return executePlannerPathFn(ctx, {
      plannerMaxTokens: this.plannerMaxTokens,
      delegationNestingDepth: this.delegationNestingDepth,
      delegationDecisionConfig: this.delegationDecisionConfig,
      subagentVerifierConfig: this.subagentVerifierConfig,
      delegationDefaultStrategyArmId: this.delegationDefaultStrategyArmId,
      allowedTools: this.allowedTools,
      delegationBanditTuner: this.delegationBanditTuner,
      resolveHostToolingProfile: this.resolveHostToolingProfile,
      resolveHostWorkspaceRoot: this.resolveHostWorkspaceRoot,
    }, {
      emitPlannerTrace: (c, type, payload) => this.emitPlannerTrace(c, type, payload),
      setStopReason: (c, reason, detail) => this.setStopReason(c, reason, detail),
      checkRequestTimeout: (c, stage) => this.checkRequestTimeout(c, stage),
      callModelForPhase: (c, input) => this.callModelForPhase(c, input),
      appendToolRecord: (c, record) => this.appendToolRecord(c, record),
      runPipelineWithTimeout: (c, pipeline) => this.runPipelineWithTimeout(c, pipeline),
      timeoutDetail: (stage, timeoutMs) => this.timeoutDetail(stage, timeoutMs),
    });
  }

  /** Get accumulated token usage for a session. */
  getSessionTokenUsage(sessionId: string): number {
    return this.sessionTokens.get(sessionId) ?? 0;
  }

  /** Reset token usage for a specific session. */
  resetSessionTokens(sessionId: string): void {
    this.sessionTokens.delete(sessionId);
    this.toolFailureBreaker.clearSession(sessionId);
    for (const provider of this.providers) {
      provider.resetSessionState?.(sessionId);
    }
  }

  /** Clear all session token tracking. */
  clearAllSessionTokens(): void {
    this.sessionTokens.clear();
    this.toolFailureBreaker.clearAll();
    for (const provider of this.providers) {
      provider.clearSessionState?.();
    }
  }

  /** Clear all provider cooldowns. */
  clearCooldowns(): void {
    this.cooldowns.clear();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async callWithFallback(
    messages: readonly LLMMessage[],
    onStreamChunk?: StreamProgressCallback,
    messageSections?: readonly PromptBudgetSection[],
    options?: {
      providersOverride?: readonly LLMProvider[];
      statefulSessionId?: string;
      statefulResumeAnchor?: LLMStatefulResumeAnchor;
      statefulHistoryCompacted?: boolean;
      reconciliationMessages?: readonly LLMMessage[];
      routedToolNames?: readonly string[];
      toolChoice?: LLMToolChoice;
      parallelToolCalls?: boolean;
      requestDeadlineAt?: number;
      signal?: AbortSignal;
      trace?: ChatExecuteParams["trace"];
      callIndex?: number;
      callPhase?: ChatCallUsageRecord["phase"];
    },
  ): Promise<FallbackResult> {
    const startedAt = Date.now();
    const result = await callWithFallbackFn(
      {
        providers: options?.providersOverride ?? this.providers,
        cooldowns: this.cooldowns,
        promptBudget: this.promptBudget,
        retryPolicyMatrix: this.retryPolicyMatrix,
        cooldownMs: this.cooldownMs,
        maxCooldownMs: this.maxCooldownMs,
      },
      messages,
      onStreamChunk,
      messageSections,
      options,
    );
    return {
      ...result,
      durationMs: Math.max(1, Date.now() - startedAt),
    };
  }





  /** Extract plain-text content from a gateway message. */

  /**
   * Best-effort context injection. Supports both SkillInjector (`.inject()`)
   * and MemoryRetriever (`.retrieve()`) interfaces.
   */
  private async injectContext(
    ctx: ExecutionContext,
    provider: SkillInjector | MemoryRetriever | undefined,
    message: string,
    sessionId: string,
    messages: LLMMessage[],
    sections: PromptBudgetSection[],
    section: PromptBudgetSection,
  ): Promise<void> {
    if (!provider) return;
    const isSkillInjector = "inject" in provider;
    const providerKind = isSkillInjector ? "skill" : "memory";
    try {
      const detailedSkillResult =
        providerKind === "skill" && isDetailedSkillInjector(provider)
          ? await provider.injectDetailed(message, sessionId)
          : undefined;
      const detailedMemoryResult =
        providerKind === "memory" && isDetailedMemoryRetriever(provider)
          ? await provider.retrieveDetailed(message, sessionId)
          : undefined;
      const sectionMaxChars = this.getContextSectionMaxChars(section);
      const context =
        providerKind === "skill"
          ? (detailedSkillResult?.content ??
            await (provider as SkillInjector).inject(message, sessionId))
          : (detailedMemoryResult?.content ??
            await (provider as MemoryRetriever).retrieve(message, sessionId));
      const hasDetailedSkillSplit =
        providerKind === "skill" &&
        (typeof detailedSkillResult?.trustedContent === "string" ||
          typeof detailedSkillResult?.untrustedContent === "string");
      const truncatedTrustedContext =
        providerKind === "skill" &&
          typeof detailedSkillResult?.trustedContent === "string" &&
          detailedSkillResult.trustedContent.length > 0
          ? truncateText(detailedSkillResult.trustedContent, sectionMaxChars)
          : undefined;
      const truncatedUntrustedContext =
        providerKind === "skill" &&
          typeof detailedSkillResult?.untrustedContent === "string" &&
          detailedSkillResult.untrustedContent.length > 0
          ? truncateText(detailedSkillResult.untrustedContent, sectionMaxChars)
          : undefined;
      const truncatedContext = (!hasDetailedSkillSplit) &&
          typeof context === "string" &&
          context.length > 0
        ? truncateText(context, sectionMaxChars)
        : undefined;
      if (truncatedTrustedContext) {
        messages.push({
          role: "system",
          content: truncatedTrustedContext,
        });
        sections.push(section);
      }
      if (truncatedUntrustedContext) {
        messages.push({
          role: "user",
          content: truncatedUntrustedContext,
        });
        sections.push("user");
      }
      if (truncatedContext) {
        messages.push({
          role: "system",
          content: truncatedContext,
        });
        sections.push(section);
      }
      const injectedChars =
        (truncatedTrustedContext?.length ?? 0) +
        (truncatedUntrustedContext?.length ?? 0) +
        (truncatedContext?.length ?? 0);
      this.emitExecutionTrace(ctx, {
        type: "context_injected",
        phase: "initial",
        callIndex: ctx.callIndex,
        payload: {
          providerKind,
          section,
          injected: Boolean(
            truncatedTrustedContext ||
              truncatedUntrustedContext ||
              truncatedContext,
          ),
          originalChars: typeof context === "string" ? context.length : 0,
          injectedChars,
          ...(detailedSkillResult
            ? {
                trustedOriginalChars:
                  detailedSkillResult.trustedContent?.length ?? 0,
                trustedInjectedChars:
                  truncatedTrustedContext?.length ?? 0,
                untrustedOriginalChars:
                  detailedSkillResult.untrustedContent?.length ?? 0,
                untrustedInjectedChars:
                  truncatedUntrustedContext?.length ?? 0,
              }
            : {}),
          ...(detailedMemoryResult
            ? {
                curatedIncluded: detailedMemoryResult.curatedIncluded ?? false,
                estimatedTokens: detailedMemoryResult.estimatedTokens ?? 0,
                entries: (detailedMemoryResult.entries ?? []).slice(0, 8).map(
                  (entry) => ({
                    role: entry.role ?? "unknown",
                    source: entry.source ?? "unknown",
                    provenance: entry.provenance ?? "unknown",
                    score: typeof entry.combinedScore === "number"
                      ? Number(entry.combinedScore.toFixed(4))
                      : undefined,
                  }),
                ),
              }
            : {}),
        },
      });
    } catch {
      this.emitExecutionTrace(ctx, {
        type: "context_injected",
        phase: "initial",
        callIndex: ctx.callIndex,
        payload: {
          providerKind,
          section,
          injected: false,
          error: "context_injection_failed",
        },
      });
    }
  }

  private getContextSectionMaxChars(section: PromptBudgetSection): number {
    const roleContracts = this.promptBudget.memoryRoleContracts;
    const byRole = (role: "working" | "episodic" | "semantic"): number => {
      const maxChars = roleContracts?.[role]?.maxChars;
      if (typeof maxChars !== "number" || !Number.isFinite(maxChars)) {
        return MAX_CONTEXT_INJECTION_CHARS;
      }
      return Math.max(256, Math.floor(maxChars));
    };

    switch (section) {
      case "memory_working":
        return Math.min(MAX_CONTEXT_INJECTION_CHARS, byRole("working"));
      case "memory_episodic":
        return Math.min(MAX_CONTEXT_INJECTION_CHARS, byRole("episodic"));
      case "memory_semantic":
        return Math.min(MAX_CONTEXT_INJECTION_CHARS, byRole("semantic"));
      default:
        return MAX_CONTEXT_INJECTION_CHARS;
    }
  }

  private accumulateUsage(cumulative: LLMUsage, usage: LLMUsage): void {
    cumulative.promptTokens += usage.promptTokens;
    cumulative.completionTokens += usage.completionTokens;
    cumulative.totalTokens += usage.totalTokens;
  }

  private trackTokenUsage(sessionId: string, tokens: number): void {
    const current = this.sessionTokens.get(sessionId) ?? 0;

    // Delete-then-reinsert to maintain LRU order (most recent at end)
    this.sessionTokens.delete(sessionId);
    this.sessionTokens.set(sessionId, current + tokens);

    // Evict least-recently-used entries if over capacity
    if (this.sessionTokens.size > this.maxTrackedSessions) {
      const oldest = this.sessionTokens.keys().next().value;
      if (oldest !== undefined) {
        this.sessionTokens.delete(oldest);
        this.toolFailureBreaker.clearSession(oldest);
      }
    }
  }

  private createCallUsageRecord(input: {
    callIndex: number;
    phase: ChatCallUsageRecord["phase"];
    providerName: string;
    response: LLMResponse;
    beforeBudget: ChatPromptShape;
    afterBudget: ChatPromptShape;
    budgetDiagnostics?: PromptBudgetDiagnostics;
    durationMs: number;
  }): ChatCallUsageRecord {
    return {
      callIndex: input.callIndex,
      phase: input.phase,
      provider: input.providerName,
      model: input.response.model,
      finishReason: input.response.finishReason,
      usage: input.response.usage,
      durationMs: input.durationMs,
      beforeBudget: input.beforeBudget,
      afterBudget: input.afterBudget,
      providerRequestMetrics: input.response.requestMetrics,
      budgetDiagnostics: input.budgetDiagnostics,
      statefulDiagnostics: input.response.stateful,
      compactionDiagnostics: input.response.compaction,
    };
  }

  // --------------------------------------------------------------------------
  // Response evaluation
  // --------------------------------------------------------------------------


  private async evaluateResponse(
    ctx: ExecutionContext,
    content: string,
    userMessage: string,
    trace?: ChatExecuteParams["trace"],
    nextCallIndex?: number,
  ): Promise<{
    score: number;
    feedback: string;
    response: LLMResponse;
    providerName: string;
    usedFallback: boolean;
    durationMs: number;
    rerouted: boolean;
    downgraded: boolean;
    routeReason: string;
    beforeBudget: ChatPromptShape;
    afterBudget: ChatPromptShape;
    budgetDiagnostics: PromptBudgetDiagnostics;
  }> {
    const rubric = this.evaluator?.rubric ?? DEFAULT_EVAL_RUBRIC;
    const routingDecision = this.resolveRoutingDecision(ctx, "evaluator");
    let fallbackResult: FallbackResult;
    try {
      fallbackResult = await this.callWithFallback([
        { role: "system", content: rubric },
        {
          role: "user",
          content: `User request: ${userMessage.slice(0, MAX_EVAL_USER_CHARS)}\n\nResponse: ${content.slice(0, MAX_EVAL_RESPONSE_CHARS)}`,
        },
      ], undefined, undefined, {
        ...(trace
          ? {
            trace,
            callIndex: nextCallIndex,
            callPhase: "evaluator" as const,
          }
          : {}),
        providersOverride: routingDecision.route.providers,
      });
    } catch (error) {
      throw annotateFailureError(error, "response evaluation").error;
    }
    const {
      response,
      providerName,
      usedFallback,
      beforeBudget,
      afterBudget,
      budgetDiagnostics,
    } = fallbackResult;
    try {
      const parsed = JSON.parse(response.content) as {
        score?: number;
        feedback?: string;
      };
      return {
        score:
          typeof parsed.score === "number"
            ? Math.max(0, Math.min(1, parsed.score))
            : 0.5,
        feedback:
          typeof parsed.feedback === "string" ? parsed.feedback : "",
        response,
        providerName,
        usedFallback,
        durationMs: fallbackResult.durationMs,
        rerouted: routingDecision.route.rerouted || fallbackResult.usedFallback,
        downgraded: routingDecision.route.downgraded,
        routeReason: routingDecision.route.reason,
        beforeBudget,
        afterBudget,
        budgetDiagnostics,
      };
    } catch {
      return {
        score: 1.0,
        feedback: "Evaluation parse failed — accepting response",
        response,
        providerName,
        usedFallback,
        durationMs: fallbackResult.durationMs,
        rerouted: routingDecision.route.rerouted || fallbackResult.usedFallback,
        downgraded: routingDecision.route.downgraded,
        routeReason: routingDecision.route.reason,
        beforeBudget,
        afterBudget,
        budgetDiagnostics,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Context compaction
  // --------------------------------------------------------------------------

  /** Max chars of history text sent to the summarization call. */

  private async compactHistory(
    history: readonly LLMMessage[],
    sessionId: string,
    trace?: ChatExecuteParams["trace"],
    existingArtifactContext?: ArtifactCompactionState,
    keepTailCount?: number,
  ): Promise<{ history: readonly LLMMessage[]; artifactContext?: ArtifactCompactionState }> {
    const effectiveKeepTailCount = Math.max(1, keepTailCount ?? 5);
    if (history.length <= effectiveKeepTailCount) {
      return {
        history: [...history],
        artifactContext: existingArtifactContext,
      };
    }

    let narrativeSummary: string | undefined;
    const toSummarize = history.slice(0, history.length - effectiveKeepTailCount);
    let historyText = toSummarize
      .map((message) => {
        const content =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part): part is { type: "text"; text: string } => part.type === "text")
                .map((part) => part.text)
                .join(" ");
        return `[${message.role}] ${content.slice(0, 500)}`;
      })
      .join("\n");
    if (historyText.length > MAX_COMPACT_INPUT) {
      historyText = historyText.slice(-MAX_COMPACT_INPUT);
    }
    try {
      const compactResponse = await this.callWithFallback(
        [
          {
            role: "system",
            content:
              "Summarize only the durable task state from this history. Preserve key decisions, important tool outcomes, current artifacts, explicit blockers, and unfinished implementation or verification work. " +
              "If the history contains stubs, placeholders, partial work, denied commands, or anything still needing verification, list that as unresolved work. " +
              "Never say there is no unresolved work unless the history explicitly shows final completion and verification closure. Omit pleasantries.",
          },
          { role: "user", content: historyText },
        ],
        undefined,
        undefined,
        {
          ...(trace
            ? {
                trace,
                callIndex: 0,
                callPhase: "compaction" as const,
              }
            : {}),
          routedToolNames: [],
          toolChoice: "none",
          parallelToolCalls: false,
        },
      );
      narrativeSummary = compactResponse.response.content.trim() || undefined;
    } catch (error) {
      throw annotateFailureError(error, "history compaction").error;
    }

    const compacted = compactHistoryIntoArtifactContext({
      sessionId,
      history,
      keepTailCount: effectiveKeepTailCount,
      source: "executor_compaction",
      existingState: existingArtifactContext,
      ...(narrativeSummary ? { narrativeSummary } : {}),
    });

    if (this.onCompaction) {
      try {
        this.onCompaction(
          sessionId,
          narrativeSummary && narrativeSummary.trim().length > 0
            ? narrativeSummary
            : compacted.summaryText,
        );
      } catch {
        /* non-blocking */
      }
    }

    return {
      history: compacted.compactedHistory,
      artifactContext: compacted.state,
    };
  }
}
