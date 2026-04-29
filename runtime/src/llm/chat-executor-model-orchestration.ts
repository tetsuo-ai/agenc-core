/**
 * Model orchestration extracted from `ChatExecutor` (Phase F PR-7
 * E5 of the plan in TODO.MD).
 *
 * `callModelForPhase` is the single orchestration entry point for
 * every provider call in the chat pipeline. It performs:
 *   - recall budget + request deadline preflight
 *   - routed tool set resolution and active route persistence
 *   - in-flight call input compaction when the session budget is
 *     close to exhaustion
 *   - grounding message injection for `tool_followup` phases
 *   - routing decision resolution (run class, budget pressure,
 *     provider route)
 *   - parallel tool calls policy + streaming policy + structured
 *     output gating
 *   - hard-budget enforcement short-circuit
 *   - `model_call_prepared` trace event emission
 *   - the actual provider call via `callWithFallback`
 *   - post-call state updates (usage accumulation, session token
 *     tracking, economics recording, call usage ledger push)
 *
 * Threaded as a free function that takes the ctx, the phase input,
 * the executor's construction-time config bundle (providers,
 * routing/economics policies, prompt budget, retry matrix, allowed
 * tools, session-state maps + thresholds), and a small helper bag
 * carrying `resetSessionTokens` so the compaction chain can still
 * reach provider-side session state.
 *
 * @module
 */

import { callWithFallback } from "./chat-executor-fallback.js";
import { maybeCompactInFlightCallInput } from "./chat-executor-in-flight-compaction.js";
import {
  checkRequestTimeout,
  emitExecutionTrace,
  getRemainingRequestMs,
  hasModelRecallBudget,
  serializeRemainingRequestMs,
  serializeRequestTimeoutMs,
  setStopReason,
} from "./chat-executor-ctx-helpers.js";
import { resolveRoutingDecision } from "./chat-executor-config.js";
import { accumulateUsage, createCallUsageRecord } from "./chat-executor-usage.js";
import {
  applyActiveRoutedToolNames,
  resolveEffectiveRoutedToolNames,
} from "./chat-executor-routing-state.js";
import { annotateFailureError } from "./chat-executor-provider-retry.js";
import {
  getProviderRouteKey,
  resolveParallelToolCallPolicy,
  type ModelRoutingPolicy,
} from "./model-routing-policy.js";
import {
  recordRuntimeModelCall,
  type RuntimeEconomicsPolicy,
  type RuntimeRunClass,
} from "./run-budget.js";
import { canonicalizeProviderModel } from "../gateway/model-route.js";
import { trackTokenUsage } from "./chat-executor-state.js";
import { computeGrokCallCostUsd } from "./grok/pricing.js";
import type {
  ChatCallUsageRecord,
  CooldownEntry,
  ExecutionContext,
  FallbackResult,
} from "./chat-executor-types.js";
import type { HistoryCompactionDependencies } from "./chat-executor-history-compaction.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMProviderEvidence,
  LLMResponse,
  LLMStructuredOutputRequest,
  LLMToolChoice,
  StreamProgressCallback,
} from "./types.js";
import type { PromptBudgetConfig, PromptBudgetSection } from "./prompt-budget.js";
import type { LLMRetryPolicyMatrix } from "./policy.js";

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

/**
 * Dependency struct for `callModelForPhase`. Bundles every readonly
 * construction-time config field the orchestration path reads.
 * Sub-struct `historyCompaction` is reused by the nested in-flight
 * compaction call.
 */
export interface CallModelForPhaseDependencies {
  readonly historyCompaction: HistoryCompactionDependencies;
  readonly providers: readonly LLMProvider[];
  readonly cooldowns: Map<string, CooldownEntry>;
  readonly promptBudget: PromptBudgetConfig;
  readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  readonly cooldownMs: number;
  readonly maxCooldownMs: number;
  readonly economicsPolicy: RuntimeEconomicsPolicy;
  readonly modelRoutingPolicy: ModelRoutingPolicy;
  readonly allowedTools: Set<string> | null;
  readonly defaultRunClass: RuntimeRunClass | undefined;
  readonly sessionTokens: Map<string, number>;
  readonly sessionCostUsd?: Map<string, number>;
  readonly lastCallInputTokens?: Map<string, number>;
  readonly sessionTokenBudget: number | undefined;
  readonly sessionCompactionThreshold: number | undefined;
  readonly maxTrackedSessions: number;
}

/**
 * Helper callbacks for operations that cross the class boundary.
 * Currently just `resetSessionTokens`, which the in-flight
 * compaction path calls when it successfully rewrites the ctx
 * messages.
 */
export interface CallModelForPhaseHelpers {
  readonly resetSessionTokens: (sessionId: string) => void;
}

/**
 * The per-call input payload threaded through the pipeline. Matches
 * the pre-Phase-F `ChatExecutor.callModelForPhase` second argument
 * shape byte-for-byte.
 */
export interface CallModelForPhaseInput {
  readonly phase: ChatCallUsageRecord["phase"];
  readonly callMessages: readonly LLMMessage[];
  readonly callSections?: readonly PromptBudgetSection[];
  readonly onStreamChunk?: StreamProgressCallback;
  readonly promptCacheKey?: string;
  readonly routedToolNames?: readonly string[];
  readonly persistRoutedToolNames?: boolean;
  readonly toolChoice?: LLMToolChoice;
  readonly structuredOutput?: LLMStructuredOutputRequest;
  readonly preparationDiagnostics?: Record<string, unknown>;
  readonly allowRecallBudgetBypass?: boolean;
  readonly budgetReason: string;
}

/**
 * Orchestrate a single provider call for the given execution phase.
 *
 * Phase F extraction (PR-7, E5). Previously
 * `ChatExecutor.callModelForPhase`.
 */
export async function callModelForPhase(
  ctx: ExecutionContext,
  input: CallModelForPhaseInput,
  deps: CallModelForPhaseDependencies,
  helpers: CallModelForPhaseHelpers,
): Promise<LLMResponse | undefined> {
  if (!input.allowRecallBudgetBypass && !hasModelRecallBudget(ctx)) {
    setStopReason(ctx, "budget_exceeded", input.budgetReason);
    return undefined;
  }
  if (checkRequestTimeout(ctx, `${input.phase} model call`)) {
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
    allowedTools: deps.allowedTools ?? undefined,
  });
  if (input.persistRoutedToolNames !== false) {
    applyActiveRoutedToolNames(ctx, effectiveRoutedToolNames);
    ctx.transientRoutedToolNames = undefined;
  } else {
    ctx.transientRoutedToolNames = effectiveRoutedToolNames;
  }
  const compactedCallInput = await maybeCompactInFlightCallInput(
    ctx,
    {
      callMessages: input.callMessages,
      callSections: input.callSections,
    },
    {
      ...deps.historyCompaction,
      sessionTokens: deps.sessionTokens,
      sessionTokenBudget: deps.sessionTokenBudget,
      sessionCompactionThreshold: deps.sessionCompactionThreshold,
    },
    {
      resetSessionTokens: helpers.resetSessionTokens,
    },
  );
  const effectiveCallMessages = [...compactedCallInput.callMessages];
  const effectiveCallSections = compactedCallInput.callSections;
  const requestedStructuredOutput =
    input.structuredOutput?.enabled === false ||
      input.structuredOutput?.schema === undefined
      ? undefined
      : input.structuredOutput;
  let routingDecision: ReturnType<typeof resolveRoutingDecision>;
  try {
    routingDecision = resolveRoutingDecision(
      ctx,
      input.phase,
      {
        economicsPolicy: deps.economicsPolicy,
        modelRoutingPolicy: deps.modelRoutingPolicy,
        defaultRunClass: deps.defaultRunClass,
      },
      // degradedProviderNames — the class used to pre-compute this
      // via `buildDegradedProviderNames()`. In the free-function
      // form, call sites still want the same semantics, so we
      // derive the list lazily from the cooldowns Map here.
      Array.from(deps.cooldowns.entries())
        .filter(([, cooldown]) => cooldown.availableAt > Date.now())
        .map(([providerName]) => providerName),
      {
        statefulContinuationRequired: false,
        structuredOutputRequired: requestedStructuredOutput !== undefined,
        routedToolNames: effectiveRoutedToolNames,
      },
    );
  } catch (error) {
    const annotated = annotateFailureError(
      error,
      `${input.phase} routing preflight`,
    );
    setStopReason(ctx, annotated.stopReason, annotated.stopReasonDetail);
    throw annotated.error;
  }
  const parallelToolCalls = resolveParallelToolCallPolicy({
    policy: deps.modelRoutingPolicy,
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
    deps.economicsPolicy.mode === "enforce" &&
    routingDecision.pressure.hardExceeded
  ) {
    setStopReason(
      ctx,
      "budget_exceeded",
      `${routingDecision.runClass} budget ceiling reached before ${input.phase} model call`,
    );
    return undefined;
  }
  emitExecutionTrace(ctx, {
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
      remainingRequestMs: serializeRemainingRequestMs(
        getRemainingRequestMs(ctx),
      ),
      effectiveRequestTimeoutMs: serializeRequestTimeoutMs(
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
      groundingMessageAdded: false,
      activeRouteMisses: ctx.routedToolMisses,
      routedToolsExpanded: ctx.routedToolsExpanded,
      economicsRunClass: routingDecision.runClass,
      providerRoute: routingDecision.route.providers.map((provider) =>
        getProviderRouteKey(provider),
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
  const onStreamChunk: StreamProgressCallback | undefined = input.onStreamChunk;
  try {
    next = await callWithFallback(
      {
        providers: routingDecision.route.providers,
        cooldowns: deps.cooldowns,
        promptBudget: deps.promptBudget,
        retryPolicyMatrix: deps.retryPolicyMatrix,
        cooldownMs: deps.cooldownMs,
        maxCooldownMs: deps.maxCooldownMs,
      },
      effectiveCallMessages,
      onStreamChunk,
      effectiveCallSections,
      {
        requestDeadlineAt: ctx.requestDeadlineAt,
        requestTimeoutMs: ctx.effectiveRequestTimeoutMs,
        signal: ctx.signal,
        ...(input.promptCacheKey
          ? { promptCacheKey: input.promptCacheKey }
          : {}),
        ...(effectiveRoutedToolNames !== undefined
          ? { routedToolNames: effectiveRoutedToolNames }
          : {}),
        ...(input.toolChoice !== undefined
          ? { toolChoice: input.toolChoice }
          : {}),
        parallelToolCalls,
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        ...(ctx.trace
          ? {
            trace: ctx.trace,
            callIndex: ctx.callIndex + 1,
            callPhase: input.phase,
          }
          : {}),
        ...(disableStreaming ? { disableStreaming: true } : {}),
      },
    );
  } catch (error) {
    const annotated = annotateFailureError(
      error,
      `${input.phase} model call`,
    );
    setStopReason(ctx, annotated.stopReason, annotated.stopReasonDetail);
    throw annotated.error;
  }
  ctx.modelCalls++;
  ctx.lastModelStreamedContent = next.streamedContent;
  ctx.providerName = next.providerName;
  ctx.responseModel = next.response.model;
  ctx.configuredModel = next.configuredModel;
  ctx.resolvedModel = canonicalizeProviderModel(
    next.providerName,
    next.response.model ?? next.configuredModel,
  );
  ctx.providerEvidence = mergeProviderEvidence(
    ctx.providerEvidence,
    next.response.providerEvidence,
  );
  if (next.usedFallback) ctx.usedFallback = true;
  accumulateUsage(ctx.cumulativeUsage, next.response.usage);
  trackTokenUsage(
    deps.sessionTokens,
    ctx.sessionId,
    next.response.usage.totalTokens,
    deps.maxTrackedSessions,
  );
  if (deps.sessionCostUsd && next.providerName === "grok") {
    const callCost = computeGrokCallCostUsd(
      next.response.usage,
      next.response.model,
    );
    if (typeof callCost === "number" && callCost > 0) {
      const prior = deps.sessionCostUsd.get(ctx.sessionId) ?? 0;
      deps.sessionCostUsd.set(
        ctx.sessionId,
        Number((prior + callCost).toFixed(6)),
      );
    }
  }
  if (deps.lastCallInputTokens) {
    deps.lastCallInputTokens.set(
      ctx.sessionId,
      next.response.usage.promptTokens || next.response.usage.totalTokens,
    );
  }
  recordRuntimeModelCall({
    policy: deps.economicsPolicy,
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
    createCallUsageRecord({
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
