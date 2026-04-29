/**
 * Execution context initialization extracted from `ChatExecutor`
 * (Phase F PR-8 E6 of the plan in TODO.MD).
 *
 * `initializeExecutionContext` is the single entry point for
 * building an `ExecutionContext` from raw `ChatExecuteParams`. It
 * performs every pre-tool-loop side effect in one place:
 *   - effective budget limit resolution (maxToolRounds,
 *     toolBudgetPerRequest, maxModelRecallsPerRequest) honoring
 *     per-request overrides
 *   - message text extraction + routed tool name normalization
 *   - explicit deterministic / subagent orchestration requirement
 *     inference
 *   - turn execution contract resolution (workspace root,
 *     required-tool-evidence merging)
 *   - planner decision assessment + grounded-execution upgrades
 *   - pre-check session token budget + (optional) compaction
 *     before ctx construction
 *   - ctx construction via `buildDefaultExecutionContext`
 *   - system anchor + context injection (skill / identity / memory
 *     / learning / progress) + artifact context appending
 *   - history + user message append with reconciliation messages
 *
 * Threaded as a pure free function that takes the params, the
 * executor's construction-time config bundle, and a small helper
 * bag carrying `resetSessionTokens` so the compaction fallback path
 * can still clear provider-side session state.
 *
 * @module
 */

import { collectContextSections } from "./chat-executor-context-injection.js";
import { compactHistory } from "./chat-executor-history-compaction.js";
import { runPostCompactCleanup } from "./compact/post-compact-cleanup.js";
import {
  pushMessage,
  setStopReason,
} from "./chat-executor-ctx-helpers.js";
import {
  buildCurrentApiView,
  buildCurrentContextUsageSnapshot,
} from "./compact/context-window.js";
import {
  extractMessageText,
  normalizeHistory,
  normalizeHistoryForStatefulReconciliation,
  appendUserMessage,
} from "./chat-executor-text.js";
import {
  flattenPromptEnvelope,
  normalizePromptEnvelope,
  type PromptEnvelopeV1,
  type PromptSection,
} from "./prompt-envelope.js";
import {
  mergeTurnExecutionRequiredToolEvidence,
  resolveTurnExecutionContract,
} from "./turn-execution-contract.js";
import { isConcordiaSimulationTurnMessage } from "./chat-executor-turn-contracts.js";
import {
  buildDefaultExecutionContext,
  type ChatExecuteParams,
  type CooldownEntry,
  type ExecutionContext,
  type SkillInjector,
  type MemoryRetriever,
  type PlannerDecision,
} from "./chat-executor-types.js";
import { normalizeRuntimeLimit } from "./runtime-limit-policy.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./chat-executor-constants.js";
import type { HistoryCompactionDependencies } from "./chat-executor-history-compaction.js";
import type { LLMProvider, StreamProgressCallback, ToolHandler } from "./types.js";
import type { PromptBudgetConfig } from "./prompt-budget.js";
import type {
  RuntimeEconomicsPolicy,
  RuntimeRunClass,
} from "./run-budget.js";

/**
 * Normalize a request timeout value against the runtime default.
 * Extracted here so the init free function does not need to
 * reference the class's static helper.
 */
export function normalizeInitRequestTimeoutMs(
  timeoutMs: number | undefined,
): number {
  return normalizeRuntimeLimit(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
}

/**
 * Dependency struct for `initializeExecutionContext`. Bundles every
 * construction-time readonly field the init path reads. Nested
 * `historyCompaction` sub-struct reuses the one built for PR-6.
 */
export interface InitializeExecutionContextDependencies {
  // Budget defaults
  readonly maxToolRounds: number;
  readonly toolBudgetPerRequest: number;
  readonly maxModelRecallsPerRequest: number;
  readonly maxFailureBudgetPerRequest: number;
  readonly requestTimeoutMs: number;
  readonly turnOutputTokenBudget: number | null;
  // Routing + enforcement
  readonly allowedTools: Set<string> | null;
  readonly plannerEnabled: boolean;
  readonly defaultRunClass: RuntimeRunClass | undefined;
  readonly economicsPolicy: RuntimeEconomicsPolicy;
  readonly providers: readonly LLMProvider[];
  // Context injectors
  readonly skillInjector: SkillInjector | undefined;
  readonly identityProvider: MemoryRetriever | undefined;
  readonly memoryRetriever: MemoryRetriever | undefined;
  readonly learningProvider: MemoryRetriever | undefined;
  readonly progressProvider: MemoryRetriever | undefined;
  // Session state + thresholds
  readonly sessionTokens: Map<string, number>;
  readonly sessionCostUsd?: Map<string, number>;
  readonly lastCallInputTokens?: Map<string, number>;
  readonly sessionTokenBudget: number | undefined;
  readonly sessionCompactionThreshold: number | undefined;
  readonly cooldowns: Map<string, CooldownEntry>;
  // Prompt/tool limits + misc
  readonly promptBudget: PromptBudgetConfig;
  readonly toolHandler: ToolHandler | undefined;
  readonly onStreamChunk: StreamProgressCallback | undefined;
  readonly resolveHostWorkspaceRoot: (() => string | null) | undefined;
  readonly runtimeContractFlags: import("../runtime-contract/types.js").RuntimeContractFlags;
  // History compaction sub-struct
  readonly historyCompaction: HistoryCompactionDependencies;
}

/**
 * Helper callbacks that cross the class boundary. Just
 * `resetSessionTokens` — the compaction fallback and post-compaction
 * reset both need to talk back to the class's session-reset helper.
 */
export interface InitializeExecutionContextHelpers {
  readonly resetSessionTokens: (sessionId: string) => void;
}

/**
 * Build the execution context for a chat execute() request.
 *
 * Phase F extraction (PR-8, E6). Previously
 * `ChatExecutor.initializeExecutionContext`.
 */
export async function initializeExecutionContext(
  params: ChatExecuteParams,
  deps: InitializeExecutionContextDependencies,
  helpers: InitializeExecutionContextHelpers,
): Promise<ExecutionContext> {
  const { message, sessionId, signal } = params;
  let { history } = params;
  const effectiveMaxToolRounds =
    typeof params.maxToolRounds === "number" && Number.isFinite(params.maxToolRounds)
      ? normalizeRuntimeLimit(params.maxToolRounds, deps.maxToolRounds)
      : deps.maxToolRounds;
  const effectiveToolBudget =
    typeof params.toolBudgetPerRequest === "number" &&
      Number.isFinite(params.toolBudgetPerRequest)
      ? normalizeRuntimeLimit(
          params.toolBudgetPerRequest,
          deps.toolBudgetPerRequest,
        )
      : deps.toolBudgetPerRequest;
  const effectiveMaxModelRecalls =
    typeof params.maxModelRecallsPerRequest === "number" &&
      Number.isFinite(params.maxModelRecallsPerRequest)
      ? normalizeRuntimeLimit(
          params.maxModelRecallsPerRequest,
          deps.maxModelRecallsPerRequest,
        )
      : deps.maxModelRecallsPerRequest;
  const effectiveFailureBudget =
    typeof params.maxFailureBudgetPerRequest === "number" &&
      Number.isFinite(params.maxFailureBudgetPerRequest)
      ? normalizeRuntimeLimit(
          params.maxFailureBudgetPerRequest,
          deps.maxFailureBudgetPerRequest,
        )
      : deps.maxFailureBudgetPerRequest;
  const messageText = extractMessageText(message);
  const interactivePromptSnapshot =
    params.interactiveContext?.state.cacheSafePromptSnapshot;
  const interactivePromptEnvelope = interactivePromptSnapshot
    ? normalizePromptEnvelope({
        baseSystemPrompt: interactivePromptSnapshot.baseSystemPrompt,
        systemSections: interactivePromptSnapshot.systemContextBlocks,
        userSections: interactivePromptSnapshot.userContextBlocks,
      })
    : normalizePromptEnvelope(params.promptEnvelope);
  const initialRoutedToolNames = params.toolRouting?.routedToolNames
    ? Array.from(new Set(params.toolRouting.routedToolNames))
    : [];
  const expandedRoutedToolNames = params.toolRouting?.expandedToolNames
    ? Array.from(new Set(params.toolRouting.expandedToolNames))
    : [];
  const isConcordiaTurnMessage = isConcordiaSimulationTurnMessage(message);
  const turnExecutionContract = resolveTurnExecutionContract({
    message,
    runtimeContext: {
      ...(params.runtimeContext ?? {}),
      workspaceRoot:
        params.runtimeContext?.workspaceRoot ??
        deps.resolveHostWorkspaceRoot?.() ??
        undefined,
    },
    requiredToolEvidence: params.requiredToolEvidence,
  });
  // The planner subsystem has been deleted (chat-executor-planner.ts is a
  // stub that always returns shouldPlan: false). Every planner decision
  // collapses to a single constant. The explicit-requirement branches that
  // used to upgrade planner decisions are statically dead — dropped with
  // the planner module in PR-9.
  const plannerDecision: PlannerDecision = {
    score: 0,
    shouldPlan: false,
    reason: "planner_disabled",
  };

  // Pre-check token budget — attempt compaction instead of hard fail
  let compacted = false;
  const preflightCompactionState = buildCurrentContextUsageSnapshot({
    messages: buildCurrentApiView({
      baseSystemPrompt: interactivePromptEnvelope.baseSystemPrompt,
      artifactContext: undefined,
      summaryText: params.interactiveContext?.summaryText,
      history,
    }),
    contextWindowTokens: deps.promptBudget.contextWindowTokens,
    maxOutputTokens: deps.promptBudget.maxOutputTokens,
  });
  if (
    preflightCompactionState.isAboveAutocompactThreshold
  ) {
    const cooldownSnapshot = new Map<string, CooldownEntry>(deps.cooldowns);
    try {
      const compactedResult = await compactHistory(
        history,
        sessionId,
        deps.historyCompaction,
        {
          ...(params.trace ? { trace: params.trace } : {}),
        },
      );
      history = compactedResult.history;
      helpers.resetSessionTokens(sessionId);
      compacted = true;
      runPostCompactCleanup(sessionId);
    } catch {
      deps.cooldowns.clear();
      for (const [providerName, cooldown] of cooldownSnapshot.entries()) {
        deps.cooldowns.set(providerName, cooldown);
      }
    }
  }

  const resolvedRequiredToolEvidence = mergeTurnExecutionRequiredToolEvidence({
    base: params.requiredToolEvidence,
    turnExecutionContract,
  });
  const promptEnvelope = interactivePromptEnvelope;

  const ctx = buildDefaultExecutionContext(
    {
      message,
      messageText,
      promptEnvelope,
      sessionId,
      structuredOutput: params.structuredOutput,
      runtimeContext: params.runtimeContext,
      turnExecutionContract,
      signal,
      history,
      plannerDecision,
      compacted,
      toolHandler: params.toolHandler ?? deps.toolHandler,
      streamCallback: params.onStreamChunk ?? deps.onStreamChunk,
      toolRouting: params.toolRouting,
      trace: params.trace,
      requiredToolEvidence: resolvedRequiredToolEvidence,
      initialRoutedToolNames,
      expandedRoutedToolNames,
    },
    {
      maxToolRounds: effectiveMaxToolRounds,
      toolBudgetPerRequest: effectiveToolBudget,
      maxModelRecallsPerRequest: effectiveMaxModelRecalls,
      maxFailureBudgetPerRequest: effectiveFailureBudget,
      requestTimeoutMs: normalizeInitRequestTimeoutMs(
        params.requestTimeoutMs ?? deps.requestTimeoutMs,
      ),
      turnOutputTokenBudget:
        typeof params.turnOutputTokenBudget === "number" &&
          Number.isFinite(params.turnOutputTokenBudget) &&
          params.turnOutputTokenBudget > 0
          ? Math.max(1, Math.floor(params.turnOutputTokenBudget))
          : params.turnOutputTokenBudget === null
            ? null
            : deps.turnOutputTokenBudget,
      providerName: deps.providers[0]?.name ?? "unknown",
      plannerEnabled: deps.plannerEnabled,
      defaultRunClass: deps.defaultRunClass,
      economicsPolicy: deps.economicsPolicy,
      runtimeContractFlags: deps.runtimeContractFlags,
    },
  );

  if (turnExecutionContract.invalidReason) {
    setStopReason(ctx, "validation_error", turnExecutionContract.invalidReason);
    ctx.finalContent = turnExecutionContract.invalidReason;
    return ctx;
  }

  const systemSections: PromptSection[] = [...ctx.promptEnvelope.systemSections];
  const userSections: PromptSection[] = [...ctx.promptEnvelope.userSections];
  if (
    interactivePromptSnapshot?.sessionStartContextMessages &&
    interactivePromptSnapshot.sessionStartContextMessages.length > 0
  ) {
    for (const message of interactivePromptSnapshot.sessionStartContextMessages) {
      if (typeof message.content !== "string" || message.content.trim().length === 0) {
        continue;
      }
      systemSections.push({
        source: "session_start_context",
        content: message.content.trim(),
      });
    }
  }
  if (
    typeof params.interactiveContext?.summaryText === "string" &&
    params.interactiveContext.summaryText.trim().length > 0
  ) {
    systemSections.push({
      source: "interactive_summary",
      content: params.interactiveContext.summaryText.trim(),
    });
  }

  const isConcordiaTurn = isConcordiaTurnMessage;
  const hasInteractiveContext = params.interactiveContext !== undefined;
  const enableSkillContext =
    params.contextInjection?.skills !== false && !isConcordiaTurn;
  const enableIdentityContext = !isConcordiaTurn;
  const enableMemoryContext =
    params.contextInjection?.memory !== false &&
    !isConcordiaTurn &&
    !hasInteractiveContext;

  // Context injection — skill, identity, memory, and learning (all best-effort)
  const contextInjectionDeps = { promptBudget: deps.promptBudget };
  if (enableSkillContext) {
    const sections = await collectContextSections(
      ctx,
      deps.skillInjector,
      ctx.messageText,
      ctx.sessionId,
      "system_runtime",
      contextInjectionDeps,
    );
    for (const entry of sections) {
      (entry.role === "user" ? userSections : systemSections).push(entry.section);
    }
  }
  // Phase 5.4: inject agent identity (personality, beliefs, traits) after skills
  // but before memory/learning so the agent's persona frames retrieved context.
  // Identity is always injected (not gated on hasHistory) since it defines who the agent is.
  if (enableIdentityContext && deps.identityProvider) {
    const sections = await collectContextSections(
      ctx,
      deps.identityProvider,
      ctx.messageText,
      ctx.sessionId,
      "system_runtime",
      contextInjectionDeps,
    );
    for (const entry of sections) {
      systemSections.push(entry.section);
    }
  }
  // Persistent semantic memory (workspace-scoped, cross-session) is always
  // injected — it provides facts learned in prior sessions (e.g. user's name).
  // The retriever handles its own scoping: working memory is session-scoped,
  // semantic/episodic memory is workspace-scoped with maxAge filtering.
  if (enableMemoryContext && ctx.hasHistory) {
    const sections = await collectContextSections(
      ctx,
      deps.memoryRetriever,
      ctx.messageText,
      ctx.sessionId,
      "memory_semantic",
      contextInjectionDeps,
    );
    for (const entry of sections) {
      systemSections.push(entry.section);
    }
  }
  // Session-scoped providers (learning patterns, progress tracker) are gated
  // on hasHistory since they rely on current-session context and should not
  // inject stale session state into a truly fresh first turn.
  if (enableMemoryContext && ctx.hasHistory) {
    const learningSections = await collectContextSections(
      ctx,
      deps.learningProvider,
      ctx.messageText,
      ctx.sessionId,
      "memory_episodic",
      contextInjectionDeps,
    );
    for (const entry of learningSections) {
      systemSections.push(entry.section);
    }
    const progressSections = await collectContextSections(
      ctx,
      deps.progressProvider,
      ctx.messageText,
      ctx.sessionId,
      "memory_working",
      contextInjectionDeps,
    );
    for (const entry of progressSections) {
      systemSections.push(entry.section);
    }
  }

  ctx.promptEnvelope = {
    kind: "prompt_envelope_v1",
    baseSystemPrompt: ctx.baseSystemPrompt,
    systemSections,
    userSections,
  } as PromptEnvelopeV1;

  const flattenedCallPrefix = flattenPromptEnvelope("call", {
    envelope: ctx.promptEnvelope,
  });
  ctx.messages.push(...flattenedCallPrefix.messages);
  ctx.messageSections.push(...flattenedCallPrefix.sections);

  const flattenedReconciliationPrefix = flattenPromptEnvelope("reconciliation", {
    envelope: ctx.promptEnvelope,
  });
  ctx.reconciliationMessages.push(...flattenedReconciliationPrefix.messages);

  // Append history and user message
  const normalizedHistory = normalizeHistory(ctx.history);
  const reconciliationHistory = normalizeHistoryForStatefulReconciliation(
    ctx.history,
  );
  for (let index = 0; index < normalizedHistory.length; index++) {
    pushMessage(
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
