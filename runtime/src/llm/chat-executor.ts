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
} from "./prompt-budget.js";
import type {
  LLMRetryPolicyMatrix,
} from "./policy.js";
import {
  buildModelRoutingPolicy,
  type ModelRoutingPolicy,
} from "./model-routing-policy.js";
import type { HookRegistry } from "./hooks/index.js";
import {
  buildStopHookRuntime,
  type StopHookRuntime,
} from "./hooks/stop-hooks.js";
import type { CanUseToolFn } from "./can-use-tool.js";
import type { IsConcurrencySafeFn } from "./tool-orchestration.js";
import type {
  ContentReplacementState,
  ToolBudgetConfig,
} from "./tool-result-budget.js";
import type { RuntimeContractFlags } from "../runtime-contract/types.js";
// ---------------------------------------------------------------------------
// Imports from extracted sibling modules
// ---------------------------------------------------------------------------

import type {
  SkillInjector,
  MemoryRetriever,
  ChatExecuteParams,
  ChatExecutorResult,
  ChatExecutorConfig,
  CooldownEntry,
  ExecutionContext,
} from "./chat-executor-types.js";
import {
  buildRuntimeEconomicsPolicy,
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
} from "./chat-executor-constants.js";
import {
  resolveRetryPolicyMatrix,
} from "./chat-executor-tool-utils.js";
import {
  type HistoryCompactionDependencies,
} from "./chat-executor-history-compaction.js";
import {
  callModelForPhase as callModelForPhaseFree,
  type CallModelForPhaseDependencies,
  type CallModelForPhaseInput,
} from "./chat-executor-model-orchestration.js";
import {
  executeRequest as executeRequestFree,
  type ExecuteRequestDependencies,
} from "./chat-executor-request.js";
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
  ChatToolRoutingSummary,
  ChatExecutorResult,
  DeterministicPipelineExecutor,
  LLMRetryPolicyOverrides,
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
  private readonly resolveHostWorkspaceRoot?: () => string | null;
  private readonly economicsPolicy: RuntimeEconomicsPolicy;
  private readonly modelRoutingPolicy: ModelRoutingPolicy;
  private readonly defaultRunClass?: RuntimeRunClass;
  private readonly runtimeContractFlags: RuntimeContractFlags;
  private readonly stopHookRuntime?: StopHookRuntime;
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
  private readonly sessionCostUsd = new Map<string, number>();
  private readonly lastCallInputTokens = new Map<string, number>();

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
    this.runtimeContractFlags = config.runtimeContractFlags ?? {
      runtimeContractV2: false,
      stopHooksEnabled: true,
      asyncTasksEnabled: false,
      persistentWorkersEnabled: false,
      mailboxEnabled: false,
      verifierRuntimeRequired: false,
      verifierProjectBootstrap: false,
      workerIsolationWorktree: false,
      workerIsolationRemote: false,
    };
    this.stopHookRuntime =
      config.stopHookRuntime ??
      (this.runtimeContractFlags.stopHooksEnabled
        ? buildStopHookRuntime({})
        : undefined);
    this.hookRegistry = config.hookRegistry;
    this.canUseTool = config.canUseTool;
    this.isConcurrencySafe = config.isConcurrencySafe;
    this.toolResultBudget = config.toolResultBudget;
    this.consolidationHook = config.consolidationHook;
  }

  /**
   * Execute a chat message against the provider chain. After Phase F
   * PR-8, this method is a thin delegator that builds the executor's
   * dependency struct and forwards to the free `executeRequest` in
   * chat-executor-request.ts.
   */
  async execute(params: ChatExecuteParams): Promise<ChatExecutorResult> {
    return executeRequestFree(
      params,
      this.buildExecuteRequestDeps(),
      {
        resetSessionTokens: (sessionId: string) =>
          this.resetSessionTokens(sessionId),
        executeToolCallLoop: (ctx) => this.executeToolCallLoop(ctx),
        sessionTokens: this.sessionTokens,
      },
    );
  }

  /**
   * Build the dependency struct consumed by `executeRequest` and the
   * nested `initializeExecutionContext` free helpers. Bundles every
   * readonly construction-time field the orchestration path reads.
   */
  private buildExecuteRequestDeps(): ExecuteRequestDependencies {
    return {
      historyCompaction: this.buildHistoryCompactionDeps(),
      // Budget defaults
      maxToolRounds: this.maxToolRounds,
      toolBudgetPerRequest: this.toolBudgetPerRequest,
      maxModelRecallsPerRequest: this.maxModelRecallsPerRequest,
      maxFailureBudgetPerRequest: this.maxFailureBudgetPerRequest,
      requestTimeoutMs: this.requestTimeoutMs,
      turnOutputTokenBudget: null,
      // Routing + enforcement
      allowedTools: this.allowedTools,
      plannerEnabled: this.plannerEnabled,
      defaultRunClass: this.defaultRunClass,
      economicsPolicy: this.economicsPolicy,
      providers: this.providers,
      // Context injectors
      skillInjector: this.skillInjector,
      identityProvider: this.identityProvider,
      memoryRetriever: this.memoryRetriever,
      learningProvider: this.learningProvider,
      progressProvider: this.progressProvider,
      // Session state + thresholds
      sessionTokens: this.sessionTokens,
      sessionCostUsd: this.sessionCostUsd,
      lastCallInputTokens: this.lastCallInputTokens,
      sessionTokenBudget: this.sessionTokenBudget,
      sessionCompactionThreshold: this.sessionCompactionThreshold,
      cooldowns: this.cooldowns,
      // Prompt/tool limits + misc
      promptBudget: this.promptBudget,
      toolHandler: this.toolHandler,
      onStreamChunk: this.onStreamChunk,
      resolveHostWorkspaceRoot: this.resolveHostWorkspaceRoot,
      runtimeContractFlags: this.runtimeContractFlags,
      // Hook registry (optional)
      hookRegistry: this.hookRegistry,
    };
  }

  // ===========================================================================
  // Private dep struct builders — consumed by the free orchestration helpers
  // ===========================================================================


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
      sessionCostUsd: this.sessionCostUsd,
      lastCallInputTokens: this.lastCallInputTokens,
      sessionTokenBudget: this.sessionTokenBudget,
      sessionCompactionThreshold: this.sessionCompactionThreshold,
      maxTrackedSessions: this.maxTrackedSessions,
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


  private async executeToolCallLoop(
    ctx: ExecutionContext,
  ): Promise<import("./chat-executor-types.js").ToolLoopTerminalResult> {
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
      contextWindowTokens: this.promptBudget.contextWindowTokens,
      maxOutputTokens: this.promptBudget.maxOutputTokens,
      runtimeContractFlags: this.runtimeContractFlags,
      ...(this.stopHookRuntime ? { stopHookRuntime: this.stopHookRuntime } : {}),
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

  /**
   * Get the accumulated USD cost for a session, or `undefined` when no
   * priced call has been recorded yet. Undefined is distinguished from
   * zero so the TUI can skip rendering the chip for unpriced providers
   * instead of falsely asserting "$0.0000".
   */
  getSessionCostUsd(sessionId: string): number | undefined {
    return this.sessionCostUsd.get(sessionId);
  }

  /** Get the input token count from the most recent model call for a session. */
  getLastCallInputTokens(sessionId: string): number {
    return this.lastCallInputTokens.get(sessionId) ?? 0;
  }

  /** Reset token usage for a specific session. */
  resetSessionTokens(sessionId: string): void {
    this.sessionTokens.delete(sessionId);
    this.sessionCostUsd.delete(sessionId);
  }

  /** Clear all session token tracking. */
  clearAllSessionTokens(): void {
    this.sessionTokens.clear();
    this.sessionCostUsd.clear();
  }

  /** Clear all provider cooldowns. */
  clearCooldowns(): void {
    this.cooldowns.clear();
  }

}
