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
  LLMMessage,
  LLMResponse,
  StreamProgressCallback,
  ToolHandler,
} from "./types.js";
import type {
  PromptBudgetConfig,
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
  type ModelRoutingPolicy,
} from "./model-routing-policy.js";
import { isConcordiaSimulationTurnMessage } from "./chat-executor-turn-contracts.js";
import type { HookRegistry } from "./hooks/index.js";
import { dispatchHooks, defaultHookExecutor } from "./hooks/index.js";
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
  ChatBudgetExceededError,
  buildDefaultExecutionContext,
} from "./chat-executor-types.js";
import type {
  SkillInjector,
  MemoryRetriever,
  ChatExecuteParams,
  ChatPlannerSummary,
  ChatExecutorResult,
  ChatExecutorConfig,
  CooldownEntry,
  ExecutionContext,
} from "./chat-executor-types.js";
import {
  buildRuntimeEconomicsPolicy,
  buildRuntimeEconomicsSummary,
  type RuntimeEconomicsPolicy,
  type RuntimeRunClass,
} from "./run-budget.js";
import {
  normalizeRuntimeLimit,
} from "./runtime-limit-policy.js";
import {
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
} from "./chat-executor-constants.js";
import {
  resolveRetryPolicyMatrix,
} from "./chat-executor-tool-utils.js";
import { ToolFailureCircuitBreaker } from "./tool-failure-circuit-breaker.js";
import { selectRelevantArtifactRefs } from "./context-pruning.js";
import {
  checkRequestTimeout as checkRequestTimeoutFree,
  pushMessage as pushMessageFree,
  setStopReason as setStopReasonFree,
} from "./chat-executor-ctx-helpers.js";
import {
  getSessionCompactionState as getSessionCompactionStateFree,
} from "./chat-executor-state.js";

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

import {
  extractMessageText,
  sanitizeFinalContent,
  normalizeHistory,
  normalizeHistoryForStatefulReconciliation,
  appendUserMessage,
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
  compactHistory as compactHistoryFree,
  type HistoryCompactionDependencies,
} from "./chat-executor-history-compaction.js";
import {
  injectContext as injectContextFree,
} from "./chat-executor-context-injection.js";
import {
  callModelForPhase as callModelForPhaseFree,
  type CallModelForPhaseDependencies,
  type CallModelForPhaseInput,
} from "./chat-executor-model-orchestration.js";
import {
  deriveActiveTaskContext,
  mergeTurnExecutionRequiredToolEvidence,
  resolveTurnExecutionContract,
} from "./turn-execution-contract.js";
import {
  buildToolLoopCallbacks as buildToolLoopCallbacksFree,
  executeToolCallLoop as executeToolCallLoopFn,
} from "./chat-executor-tool-loop.js";
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
  /**
   * Phase N: optional memory consolidation hook threaded into the
   * per-iteration compaction chain. See ChatExecutorConfig for shape.
   */
  private readonly consolidationHook?: (
    messages: readonly LLMMessage[],
  ) => {
    readonly action: "noop" | "consolidated";
    readonly summaryMessage?: LLMMessage;
  };
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
    this.consolidationHook = config.consolidationHook;
  }

  /**
   * Execute a chat message against the provider chain.
   *
   * Phase F (16-phase refactor) note: Phase E already routes every
   * production caller through the Phase C `executeChat()` async
   * generator via `executeChatToLegacyResult`. `executeChat`
   * internally calls back into this method, so making `execute`
   * itself a back-compat shim that routes through the generator
   * would create infinite recursion. The cleanest shape is to
   * keep `execute` as the single direct orchestration entry point
   * and let the generator wrap it. Phase F's real goal — deleting
   * the class body — is deferred to a follow-up PR that extracts
   * `executeRequest()` into free functions so the generator can
   * own the orchestration directly.
   */
  async execute(params: ChatExecuteParams): Promise<ChatExecutorResult> {
    return this.executeRequest(params);
  }

  private async executeRequest(
    params: ChatExecuteParams,
  ): Promise<ChatExecutorResult> {
    const ctx = await this.initializeExecutionContext(params);

    // Phase H: dispatch SessionStart the first time a session is
    // observed. `sessionTokens` is a per-session Map the executor
    // initializes lazily — absence of an entry means this is the
    // first execute() call for this session id. Mirrors
    // `claude_code/utils/sessionStart.ts:executeSessionStartHooks`.
    if (this.hookRegistry && !this.sessionTokens.has(ctx.sessionId)) {
      await dispatchHooks({
        registry: this.hookRegistry,
        event: "SessionStart",
        matchKey: ctx.sessionId,
        executor: defaultHookExecutor,
        context: {
          event: "SessionStart",
          sessionId: ctx.sessionId,
          messages: ctx.messages,
        },
      });
    }

    await this.executeToolCallLoop(ctx);

    this.checkRequestTimeout(ctx, "finalization");

    // Derive the final completion state from stop reason + tool calls.
    // The runtime no longer carries verification or completion contracts
    // through the chat-executor; both are passed as undefined.
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

    // Phase H: dispatch Stop / StopFailure at the terminal path.
    // Stop fires on completed state; StopFailure on any non-
    // completed state (budget_exceeded, no_progress, cancelled,
    // provider_error, timeout, etc.). Mirrors
    // `claude_code/query/stopHooks.ts:executeStopHooks`.
    if (this.hookRegistry) {
      const stopEvent: "Stop" | "StopFailure" =
        ctx.stopReason === "completed" || ctx.stopReason === "tool_calls"
          ? "Stop"
          : "StopFailure";
      await dispatchHooks({
        registry: this.hookRegistry,
        event: stopEvent,
        matchKey: ctx.sessionId,
        executor: defaultHookExecutor,
        context: {
          event: stopEvent,
          sessionId: ctx.sessionId,
          messages: ctx.messages,
        },
      });
    }

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
    // Phase F extraction (PR-1): delegates to pure helper.
    pushMessageFree(ctx, nextMessage, section, reconciliationMessage);
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
    // Phase F extraction (PR-1): delegates to pure helper.
    setStopReasonFree(ctx, reason, detail);
  }

  private checkRequestTimeout(ctx: ExecutionContext, stage: string): boolean {
    // Phase F extraction (PR-1): delegates to pure helper.
    return checkRequestTimeoutFree(ctx, stage);
  }





  /**
   * Build the dependency struct consumed by `callModelForPhase` and
   * the tool-loop callbacks wrapper. Bundles every readonly
   * construction-time field the free orchestration helper reads.
   */
  private buildCallModelForPhaseDeps(): CallModelForPhaseDependencies {
    return {
      historyCompaction: this.buildHistoryCompactionDeps(),
      providers: this.providers,
      cooldowns: this.cooldowns,
      promptBudget: this.promptBudget,
      retryPolicyMatrix: this.retryPolicyMatrix,
      cooldownMs: this.cooldownMs,
      maxCooldownMs: this.maxCooldownMs,
      economicsPolicy: this.economicsPolicy,
      modelRoutingPolicy: this.modelRoutingPolicy,
      allowedTools: this.allowedTools,
      defaultRunClass: this.defaultRunClass,
      sessionTokens: this.sessionTokens,
      sessionTokenBudget: this.sessionTokenBudget,
      sessionCompactionThreshold: this.sessionCompactionThreshold,
      maxTrackedSessions: this.maxTrackedSessions,
      toolFailureBreaker: this.toolFailureBreaker,
    };
  }

  private async callModelForPhase(
    ctx: ExecutionContext,
    input: CallModelForPhaseInput,
  ): Promise<LLMResponse | undefined> {
    // Phase F extraction (PR-7, E5): delegates to the free helper in
    // chat-executor-model-orchestration.ts. The method stays on the
    // class as a 1-call wrapper because the tool loop's callback
    // struct threads it through as a dependency (PR-5). PR-8 deletes
    // this delegator when executeRequest and the class itself shrink
    // to a DI container.
    return callModelForPhaseFree(
      ctx,
      input,
      this.buildCallModelForPhaseDeps(),
      {
        resetSessionTokens: (sessionId: string) =>
          this.resetSessionTokens(sessionId),
      },
    );
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
        const compactedResult = await compactHistoryFree(
          history,
          sessionId,
          this.buildHistoryCompactionDeps(),
          {
            ...(params.trace ? { trace: params.trace } : {}),
            ...(params.stateful?.artifactContext
              ? { existingArtifactContext: params.stateful.artifactContext }
              : {}),
          },
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
    const contextInjectionDeps = { promptBudget: this.promptBudget };
    if (enableSkillContext) {
      await injectContextFree(
        ctx,
        this.skillInjector,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "system_runtime",
        contextInjectionDeps,
      );
    }
    // Phase 5.4: inject agent identity (personality, beliefs, traits) after skills
    // but before memory/learning so the agent's persona frames retrieved context.
    // Identity is always injected (not gated on hasHistory) since it defines who the agent is.
    if (enableIdentityContext && this.identityProvider) {
      await injectContextFree(
        ctx,
        this.identityProvider,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "system_runtime",
        contextInjectionDeps,
      );
    }
    // Persistent semantic memory (workspace-scoped, cross-session) is always
    // injected — it provides facts learned in prior sessions (e.g. user's name).
    // The retriever handles its own scoping: working memory is session-scoped,
    // semantic/episodic memory is workspace-scoped with maxAge filtering.
    if (enableMemoryContext && ctx.hasHistory) {
      await injectContextFree(
        ctx,
        this.memoryRetriever,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_semantic",
        contextInjectionDeps,
      );
    }
    // Session-scoped providers (learning patterns, progress tracker) are gated
    // on hasHistory since they rely on current-session context and should not
    // inject stale session state into a truly fresh first turn.
    if (enableMemoryContext && ctx.hasHistory) {
      await injectContextFree(
        ctx,
        this.learningProvider,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_episodic",
        contextInjectionDeps,
      );
      await injectContextFree(
        ctx,
        this.progressProvider,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_working",
        contextInjectionDeps,
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

  /**
   * Build the dependency struct consumed by `compactHistory` and
   * `maybeCompactInFlightCallInput` free helpers. Bundles every
   * immutable construction-time config field the compaction chain
   * needs (providers, cooldowns, promptBudget, retry policy matrix,
   * cooldown bounds, optional onCompaction hook).
   */
  private buildHistoryCompactionDeps(): HistoryCompactionDependencies {
    return {
      providers: this.providers,
      cooldowns: this.cooldowns,
      promptBudget: this.promptBudget,
      retryPolicyMatrix: this.retryPolicyMatrix,
      cooldownMs: this.cooldownMs,
      maxCooldownMs: this.maxCooldownMs,
      ...(this.onCompaction ? { onCompaction: this.onCompaction } : {}),
    };
  }

  private getSessionCompactionState(sessionId: string): {
    readonly used: number;
    readonly hardBudgetReached: boolean;
    readonly softThresholdReached: boolean;
  } {
    // Phase F extraction (PR-1): delegates to pure helper with the
    // class's session token Map + budget thresholds threaded as
    // arguments.
    return getSessionCompactionStateFree(
      this.sessionTokens,
      sessionId,
      this.sessionTokenBudget,
      this.sessionCompactionThreshold,
    );
  }


  private async executeToolCallLoop(ctx: ExecutionContext): Promise<void> {
    // Phase F extraction (PR-5): delegates to the free tool-loop
    // helper. The callback struct wires the pure ctx helpers from
    // chat-executor-ctx-helpers.ts and threads `callModelForPhase`
    // through as a dependency — that is still a class method until
    // PR-7 extracts E5 into `chat-executor-model-orchestration.ts`.
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
      ...(this.consolidationHook
        ? { consolidationHook: this.consolidationHook }
        : {}),
    }, buildToolLoopCallbacksFree({
      maxRuntimeSystemHints: this.maxRuntimeSystemHints,
      callModelForPhase: (c, input) => this.callModelForPhase(c, input),
    }));
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

}
