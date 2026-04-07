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
import type {
  PromptBudgetConfig,
  PromptBudgetDiagnostics,
  PromptBudgetSection,
} from "./prompt-budget.js";
import type {
  LLMPipelineStopReason,
  LLMRetryPolicyMatrix,
} from "./policy.js";
import { resolveWorkflowCompletionState } from "../workflow/completion-state.js";
import { deriveWorkflowProgressSnapshot } from "../workflow/completion-progress.js";
import {
  buildModelRoutingPolicy,
  getProviderRouteKey,
  resolveParallelToolCallPolicy,
  resolveModelRoute,
  type ModelRoutingPolicy,
} from "./model-routing-policy.js";
import { isConcordiaSimulationTurnMessage } from "./chat-executor-turn-contracts.js";
import type { HookRegistry } from "./hooks/index.js";
import type { CanUseToolFn } from "./can-use-tool.js";
import type { IsConcurrencySafeFn } from "./tool-orchestration.js";
import type {
  ContentReplacementState,
  ToolBudgetConfig,
} from "./tool-result-budget.js";
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
  ChatExecutorConfig,
  CooldownEntry,
  FallbackResult,
  ExecutionContext,
} from "./chat-executor-types.js";
import {
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
  DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD,
  DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS,
  DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS,
  MAX_COMPACT_INPUT,
  RECOVERY_HINT_PREFIX,
} from "./chat-executor-constants.js";
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

import type {
  ToolRoundProgressSummary,
} from "./chat-executor-tool-utils.js";
import {
  extractMessageText,
  truncateText,
  sanitizeFinalContent,
  // Cut 2: reconcile* helpers no longer imported — finalContent
  // post-processing chain removed.
  normalizeHistory,
  normalizeHistoryForStatefulReconciliation,
  toStatefulReconciliationMessage,
  appendUserMessage,
  buildToolExecutionGroundingMessage,
} from "./chat-executor-text.js";
import {
  summarizeStateful,
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
  private readonly plannerEnabled: boolean;
  private readonly plannerMaxTokens: number;
  private readonly toolBudgetPerRequest: number;
  private readonly maxModelRecallsPerRequest: number;
  private readonly maxFailureBudgetPerRequest: number;
  private readonly toolCallTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  private readonly toolFailureBreaker: ToolFailureCircuitBreaker;
  private readonly resolveHostWorkspaceRoot?: () => string | null;
  private readonly economicsPolicy: RuntimeEconomicsPolicy;
  private readonly modelRoutingPolicy: ModelRoutingPolicy;
  private readonly defaultRunClass?: RuntimeRunClass;
  /**
   * Cut 5.2: optional hook registry. When set, the chat-executor fires
   * PreToolUse/PostToolUse/PostToolUseFailure events at the tool
   * dispatch boundary inside chat-executor-tool-loop.ts. With no
   * registry (the default) the hooks code paths short-circuit and the
   * runtime behaves identically to the pre-hooks shape.
   */
  private readonly hookRegistry?: HookRegistry;
  /**
   * Cut 5.7: optional canUseTool seam. When set, the runtime calls
   * this before every tool dispatch and honors deny / ask / allow with
   * optional updatedInput. With no value (the default) the seam is
   * skipped and the existing allowedTools / approval flow continues
   * unchanged.
   */
  private readonly canUseTool?: CanUseToolFn;
  /**
   * Cut 5.5: optional concurrency-safety predicate. When set, the
   * tool loop emits a per-round partition trace recording which tool
   * calls could have been dispatched in parallel. Dispatch itself
   * remains serial; the telemetry lets operators see the parallelism
   * opportunity before wiring real parallel dispatch.
   */
  private readonly isConcurrencySafe?: IsConcurrencySafeFn;
  /**
   * Cut 5.3: tool result budget config + per-session content
   * replacement state. When the budget config is provided, oversized
   * tool results are persisted to disk and the in-memory message
   * history sees a small placeholder that includes the file path.
   * The state Map is owned by the executor and survives across the
   * tool loop rounds inside a single session.
   */
  private readonly toolResultBudget?: ToolBudgetConfig;
  private readonly toolResultBudgetState = new Map<
    string,
    ContentReplacementState
  >();

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
    this.plannerEnabled = config.plannerEnabled ?? false;
    this.plannerMaxTokens = normalizeRuntimeLimit(
      config.plannerMaxTokens,
      DEFAULT_PLANNER_MAX_TOKENS,
    );
    this.resolveHostWorkspaceRoot = config.resolveHostWorkspaceRoot;
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
    this.hookRegistry = config.hookRegistry;
    this.canUseTool = config.canUseTool;
    this.isConcurrencySafe = config.isConcurrencySafe;
    this.toolResultBudget = config.toolResultBudget;
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

    await this.executeToolCallLoop(ctx);

    this.checkRequestTimeout(ctx, "finalization");

    // Cut 2: derive the final completion state from stop reason + tool
    // calls. The planner verifier/contract path is gone; the resolver
    // collapses to defaults when given undefined contracts.
    ctx.completionState = resolveWorkflowCompletionState({
      stopReason: ctx.stopReason,
      toolCalls: ctx.allToolCalls,
      verificationContract: undefined,
      completionContract: undefined,
      completedRequestMilestoneIds: ctx.completedRequestMilestoneIds,
      validationCode: ctx.validationCode,
    });

    const durationMs = Date.now() - ctx.startTime;
    const plannerSummary: ChatPlannerSummary = ctx.plannerSummaryState;

    ctx.finalContent = sanitizeFinalContent(ctx.finalContent);
    // Cut 4: resolveWorkflowVerificationContext always returned `{}`
    // after the planner subsystem was deleted; the workflow contract
    // fields here are now plumbed as undefined.
    const completionProgress = deriveWorkflowProgressSnapshot({
      stopReason: ctx.stopReason,
      completionState: ctx.completionState,
      stopReasonDetail: ctx.stopReasonDetail,
      validationCode: ctx.validationCode,
      toolCalls: ctx.allToolCalls,
      verificationContract: undefined,
      completionContract: undefined,
      completedRequestMilestoneIds: ctx.completedRequestMilestoneIds,
      updatedAt: Date.now(),
      contractFingerprint: ctx.turnExecutionContract.contractFingerprint,
    });

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

  // Cut 4: resolveWorkflowVerificationContext deleted (returned `{}`
  // unconditionally after the planner-era contract flow was removed).

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
    const groundedExecutionRequested =
      !isConcordiaTurnMessage &&
      turnExecutionContract.turnClass === "workflow_implementation" &&
      requestRequiresToolGroundedExecution(messageText);
    let plannerDecision = assessPlannerDecision(
      this.plannerEnabled,
      messageText,
      history,
      params.message.metadata,
    );
    if (
      !isConcordiaTurnMessage &&
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
        defaultRunClass: this.defaultRunClass,
        economicsPolicy: this.economicsPolicy,
      },
    );

    if (turnExecutionContract.invalidReason) {
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
      ...(this.hookRegistry ? { hookRegistry: this.hookRegistry } : {}),
      ...(this.canUseTool ? { canUseTool: this.canUseTool } : {}),
      ...(this.isConcurrencySafe
        ? { isConcurrencySafe: this.isConcurrencySafe }
        : {}),
      ...(this.toolResultBudget
        ? {
            toolResultBudget: this.toolResultBudget,
            toolResultBudgetState: this.toolResultBudgetState,
          }
        : {}),
    }, this.buildToolLoopCallbacks());
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
