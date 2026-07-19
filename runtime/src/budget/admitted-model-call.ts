/** Shared M3 boundary for logical model calls. */

import type { Session } from "../session/session.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMProviderExecutionProfile,
  LLMResponse,
} from "../llm/types.js";
import { roughTokenCountEstimationForProvider } from "../llm/token-estimation.js";
import {
  computeUsdCostWithResolution,
  DEFAULT_MODEL_COSTS,
  resolveModelCostEntry,
  type ModelCostEntry,
  type ModelUsage,
} from "../session/cost.js";
import { AdmissionDeniedError } from "./admission-client.js";
import { hitM4DurabilityFailpoint } from "../durability/failpoints.js";

export interface AdmittedModelCallOptions {
  readonly session: Session;
  readonly provider: LLMProvider;
  readonly messages: LLMMessage[];
  readonly options: LLMChatOptions;
  readonly stepId: string;
  readonly sessionId?: string;
  readonly parentRunId?: string;
  readonly parentScopeId?: string;
  readonly model: string;
  readonly providerName: string;
  readonly signal?: AbortSignal;
  readonly fallback?: {
    readonly fromModel: string;
    readonly fromProvider?: string;
    readonly reason: string;
  };
  /** Called only after an acquired step has durable fallback evidence. */
  readonly onFallbackRecorded?: () => void;
  readonly invoke: (options: LLMChatOptions) => Promise<LLMResponse>;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function estimateInputTokens(
  messages: readonly LLMMessage[],
  options: LLMChatOptions,
  provider: string,
  model: string,
): number {
  const serialized = JSON.stringify({
    messages,
    systemPrompt: options.systemPrompt ?? "",
    tools: options.tools ?? [],
    structuredOutput: options.structuredOutput ?? null,
  });
  const providerEstimate = Math.ceil(
    roughTokenCountEstimationForProvider(serialized, { provider, model }),
  );
  // UTF-8 bytes are a deliberately conservative tokenizer-independent upper
  // bound for caller-controlled JSON. Provider framing is added explicitly so
  // an optimistic heuristic can never make the reservation smaller.
  const byteUpperBound =
    Buffer.byteLength(serialized, "utf8") +
    256 +
    messages.length * 32 +
    (options.tools?.length ?? 0) * 64;
  return Math.max(1, providerEstimate, byteUpperBound);
}

function pricedEntry(model: string, provider: string): ModelCostEntry | null {
  const resolved = resolveModelCostEntry(
    { model, provider },
    DEFAULT_MODEL_COSTS,
  );
  if (resolved === null) return null;
  const entry = resolved.entry;
  const rates = [
    entry.inputUsdPer1K,
    entry.outputUsdPer1K,
    entry.cachedInputUsdPer1K ?? 0,
    entry.cacheCreationUsdPer1K ?? 0,
    entry.reasoningOutputUsdPer1K ?? 0,
    entry.webSearchUsdPerRequest ?? 0,
  ];
  // A zero-rate local entry does not prove that an arbitrary provider/model
  // alias is free. Keep hard USD caps fail-closed for that case.
  return rates.some((rate) => rate > 0) ? entry : null;
}

function maximumTokenCostUsd(
  model: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
  options: LLMChatOptions,
): number | null {
  const entry = pricedEntry(model, provider);
  if (entry === null) return null;
  const worstInputRate = Math.max(
    entry.inputUsdPer1K,
    entry.cachedInputUsdPer1K ?? 0,
    entry.cacheCreationUsdPer1K ?? 0,
  );
  const worstOutputRate = Math.max(
    entry.outputUsdPer1K,
    entry.reasoningOutputUsdPer1K ?? 0,
  );
  const tokenCost =
    (inputTokens / 1_000) * worstInputRate +
    (outputTokens / 1_000) * worstOutputRate;
  const serverTools = paidServerToolNames(options);
  if (
    serverTools.some(
      (name) => name !== "web_search" && name !== "x_search",
    )
  ) {
    return null;
  }
  if (serverTools.length === 0) return tokenCost;
  if (
    entry.webSearchUsdPerRequest === undefined ||
    entry.webSearchUsdPerRequest < 0
  ) {
    return null;
  }
  // A provider-native search invocation consumes output tokens to encode its
  // call. One request per admitted output token is deliberately loose but is
  // a finite, conservative ceiling; hard-capped runs still deny these server
  // tools rather than reserving this impractically broad amount.
  return tokenCost + outputTokens * entry.webSearchUsdPerRequest;
}

function usageCostUsd(
  model: string,
  provider: string,
  usage: LLMResponse["usage"],
  options: LLMChatOptions,
): number | null {
  if (pricedEntry(model, provider) === null) return null;
  if (
    paidServerToolNames(options).some(
      (name) => name !== "web_search" && name !== "x_search",
    )
  ) {
    return null;
  }
  const modelUsage: ModelUsage = {
    model,
    provider,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
    webSearchRequests: usage.webSearchRequests ?? 0,
    totalTokens: usage.totalTokens,
    turns: 1,
  };
  const resolved = computeUsdCostWithResolution(
    modelUsage,
    DEFAULT_MODEL_COSTS,
  );
  return resolved.known ? resolved.costUsd : null;
}

function reconciledTokenUsage(usage: LLMResponse["usage"]): {
  readonly inputTokens: number;
  readonly outputTokens: number;
} {
  const outputTokens = Math.max(
    usage.completionTokens,
    usage.reasoningOutputTokens ?? 0,
  );
  const inputTokens = Math.max(
    usage.promptTokens,
    (usage.cachedInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
    usage.totalTokens - outputTokens,
  );
  return { inputTokens, outputTokens };
}

function hasUnboundedPaidServerTool(options: LLMChatOptions): boolean {
  return paidServerToolNames(options).length > 0;
}

function paidServerToolNames(options: LLMChatOptions): readonly string[] {
  const paidNames = new Set([
    "web_search",
    "x_search",
    "code_interpreter",
    "file_search",
    "mcp",
  ]);
  return (options.toolRouting?.allowedToolNames ?? []).filter((name) =>
    paidNames.has(name),
  );
}

function cancellationAfterDispatch(signal: AbortSignal): Error | undefined {
  if (!signal.aborted) return undefined;
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new AdmissionDeniedError(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "admission_cancelled",
    "cancelled",
  );
}

/**
 * Admit, bound, dispatch and reconcile one logical provider call.
 *
 * A provider failure after the dispatch marker is conservative: usage becomes
 * `held_unknown`; generic catch/finally code must never refund it as zero.
 */
export async function runAdmittedModelCall(
  params: AdmittedModelCallOptions,
): Promise<LLMResponse> {
  const client = params.session.services.executionAdmission;
  if (client === undefined) {
    if (params.session.services.admissionRequired !== false) {
      throw new AdmissionDeniedError("admission_kernel_unavailable");
    }
    return params.invoke(params.options);
  }

  const configuredMaxOutputTokens = positiveInteger(
    params.options.maxOutputTokens,
  );
  // A denied preflight still enters the durable admission API. Zero is only
  // a persisted placeholder for the rejected request; it never reaches a
  // provider because denialReason is resolved before queue/claim.
  const maxOutputTokens = configuredMaxOutputTokens ?? 0;

  const stagedFallbackEvent =
    params.fallback === undefined
      ? undefined
      : {
          stepId: params.stepId,
          fromModel: params.fallback.fromModel,
          toModel: params.model,
          ...(params.fallback.fromProvider !== undefined
            ? { fromProvider: params.fallback.fromProvider }
            : {}),
          toProvider: params.providerName,
          reason: params.fallback.reason,
        };

  // Managed providers may route from the request-scoped model override. The
  // returned opaque handle pins that exact delegate through admission and the
  // one permitted wire attempt, eliminating profile/dispatch re-resolution.
  let profile: LLMProviderExecutionProfile | undefined;
  try {
    profile = await params.provider.getExecutionProfile?.(params.options);
  } catch (error) {
    // Profile resolution precedes acquisition because its concrete identity
    // determines the reservation. If this exact step already exists (for
    // example after restart), preserve the staged fallback in its journal.
    // recordFallback is otherwise a no-op; the caller intentionally receives
    // no handoff callback and retains the decision for a later retry.
    if (stagedFallbackEvent !== undefined) {
      try {
        client.recordFallback(stagedFallbackEvent);
      } catch {
        // No lease exists to clean up and the pending decision remains the
        // recovery authority. Preserve the profile error as the primary cause.
      }
    }
    throw error;
  }
  const routedProvider = profile?.provider?.trim();
  const usesConcreteExecutionIdentity =
    routedProvider !== undefined &&
    routedProvider.length > 0 &&
    routedProvider !== params.providerName;
  const effectiveProvider = usesConcreteExecutionIdentity
    ? routedProvider
    : params.providerName;
  const effectiveModel =
    usesConcreteExecutionIdentity && profile?.model?.trim()
      ? profile.model.trim()
      : params.model;
  const hasHardCostCap =
    client.scope.hasHardCostCap === true ||
    client.scope.maxCostUsd !== undefined;
  const hasHardTokenCap =
    client.scope.hasHardTokenCap === true ||
    client.scope.maxTokens !== undefined;
  // Every admitted model call needs a provider-enforced output ceiling. The
  // reservation is only a real upper bound when the request-scoped maximum
  // reaches the provider wire, regardless of whether this run currently has a
  // hard aggregate token/USD cap. Authoritative usage remains specifically a
  // hard-cap requirement; uncapped calls with missing usage are conservatively
  // held unknown after dispatch.
  const providerContractUnavailable =
    profile?.supportsMaxOutputTokens !== true ||
    ((hasHardCostCap || hasHardTokenCap) &&
      profile.usageReporting !== "authoritative");

  const maxInputTokens = estimateInputTokens(
    params.messages,
    params.options,
    effectiveProvider,
    effectiveModel,
  );
  const unboundedPaidServerTool =
    hasHardCostCap && hasUnboundedPaidServerTool(params.options);
  const maximumCost = maximumTokenCostUsd(
    effectiveModel,
    effectiveProvider,
    maxInputTokens,
    maxOutputTokens,
    params.options,
  );
  const denialReason =
    configuredMaxOutputTokens === undefined
      ? "unbounded_model_output"
      : providerContractUnavailable
        ? "provider_budget_contract_unavailable"
        : unboundedPaidServerTool
          ? "unbounded_provider_tool_under_hard_cap"
          : hasHardCostCap && maximumCost === null
            ? "unpriced_model_under_hard_cap"
            : undefined;
  const fallbackEvent = stagedFallbackEvent === undefined
    ? undefined
    : {
        ...stagedFallbackEvent,
        toModel: effectiveModel,
        toProvider: effectiveProvider,
      };
  const routingEvent = usesConcreteExecutionIdentity
    ? {
        stepId: params.stepId,
        fromModel: params.model,
        toModel: effectiveModel,
        fromProvider: params.providerName,
        toProvider: effectiveProvider,
        reason: "provider_execution_profile_resolution",
      }
    : undefined;
  let lease;
  try {
    lease = await client.acquire(
      {
        stepId: params.stepId,
        kind: "model_turn",
        ...(params.sessionId !== undefined
          ? { sessionId: params.sessionId }
          : {}),
        ...(params.parentRunId !== undefined
          ? { parentRunId: params.parentRunId }
          : {}),
        ...(params.parentScopeId !== undefined
          ? { parentScopeId: params.parentScopeId }
          : {}),
        model: effectiveModel,
        provider: effectiveProvider,
        maxInputTokens,
        maxOutputTokens,
        maxCostUsd: maximumCost,
        ...(denialReason !== undefined ? { denialReason } : {}),
      },
      params.signal,
    );
  } catch (error) {
    // Denied/queued-then-cancelled attempts still need durable routing
    // evidence. recordFallback is a no-op only when acquisition failed before
    // the repository could create the step row.
    if (fallbackEvent !== undefined) client.recordFallback(fallbackEvent);
    if (routingEvent !== undefined) client.recordFallback(routingEvent);
    throw error;
  }

  const reservationId = lease.reservation.reservationId;
  let dispatched = false;
  let settled = false;
  let lateCancellation: Error | undefined;
  try {
    // Acquisition owns durable budget and concurrency capacity. Keep routing
    // evidence inside the guarded settlement region so a journal failure
    // before the wire attempt voids the reservation and the finally path still
    // acknowledges physical completion.
    if (fallbackEvent !== undefined) {
      client.recordFallback(fallbackEvent);
      // A successful acquisition proves the step row exists, so a successful
      // recordFallback call is the durable handoff point. Profile resolution
      // and pre-acquisition failures never reach this callback, allowing the
      // caller to retain a pending recovery decision for another attempt.
      params.onFallbackRecorded?.();
    }
    if (routingEvent !== undefined) client.recordFallback(routingEvent);
    client.markDispatched(reservationId, {
      boundary: "provider_wire",
      details: {
        model: effectiveModel,
        provider: effectiveProvider,
        ...(usesConcreteExecutionIdentity
          ? {
              routedFromModel: params.model,
              routedFromProvider: params.providerName,
            }
          : {}),
        maxOutputTokens,
      },
    });
    dispatched = true;
    const response = await params.invoke({
      ...params.options,
      ...(profile?.providerExecutionHandle !== undefined
        ? { providerExecutionHandle: profile.providerExecutionHandle }
        : {}),
      // A retry or continuation fallback is a new wire attempt and therefore
      // requires a new durable reservation. Adapters must surface the error
      // to the caller instead of retrying beneath this lease.
      singleWireAttempt: true,
      // The admitted maximum is the provider-facing maximum. A caller cannot
      // raise it after reservation by mutating/rebuilding options.
      maxOutputTokens: Math.min(
        maxOutputTokens,
        lease.request.estimate.maxOutputTokens,
      ),
      // The lease signal also carries parent cancellation, deadline expiry,
      // daemon shutdown, and restart recovery decisions.
      signal: lease.signal,
    });
    // The provider has physically answered, but no durable accounting result
    // has committed. A process loss here must recover as unknown, never free.
    hitM4DurabilityFailpoint("before_model_response_commit");
    // Snapshot cancellation at physical provider settlement. Reconciliation
    // below may itself abort the lease on overrun, which is a different
    // terminal cause from a cancellation that already won the wire race.
    lateCancellation = cancellationAfterDispatch(lease.signal);
    const usage = response.usage;
    if (usage.availability !== "reported" || usage.provenance !== "provider") {
      client.holdUnknown(reservationId, "missing_provider_usage");
      settled = true;
      hitM4DurabilityFailpoint("after_model_response_commit");
      // An abort-ignoring provider may still resolve after durable
      // cancellation. Keep its conservative settlement, but never revive the
      // cancelled call by returning that response to the caller.
      if (lateCancellation !== undefined) throw lateCancellation;
      return response;
    }
    if (response.model !== "" && response.model !== effectiveModel) {
      client.recordFallback({
        stepId: params.stepId,
        fromModel: effectiveModel,
        toModel: response.model,
        fromProvider: effectiveProvider,
        toProvider: effectiveProvider,
        reason: "provider_reported_model_change",
      });
    }
    const actualModel = response.model || effectiveModel;
    const actualCost = usageCostUsd(
      actualModel,
      effectiveProvider,
      usage,
      params.options,
    );
    if (actualCost === null) {
      if (hasHardCostCap) {
        // This is one durable transaction, not holdUnknown followed by a
        // separate cancellation: the dispatched reservation remains fully
        // charged while the canonical run tree, spawn edges, and admission
        // locks are committed together before any live shutdown is attempted.
        client.cancelRun("unpriced_provider_response");
      } else {
        client.holdUnknown(reservationId, "unpriced_provider_response");
      }
      settled = true;
      hitM4DurabilityFailpoint("after_model_response_commit");
      if (hasHardCostCap) {
        params.session.abortTerminal("provider_overrun");
        void params.session.services.agentControl.shutdownAgentTree?.(
          params.session.conversationId,
        );
        if (lateCancellation !== undefined) throw lateCancellation;
        throw new AdmissionDeniedError("unpriced_provider_response");
      }
      if (lateCancellation !== undefined) throw lateCancellation;
      return response;
    }
    const reconciled = reconciledTokenUsage(usage);
    const outcome = client.reconcile(reservationId, {
      inputTokens: reconciled.inputTokens,
      outputTokens: reconciled.outputTokens,
      costUsd: actualCost,
    });
    settled = true;
    hitM4DurabilityFailpoint("after_model_response_commit");
    if (outcome.outcome === "provider_overrun") {
      params.session.abortTerminal("provider_overrun");
      void params.session.services.agentControl.shutdownAgentTree?.(
        params.session.conversationId,
      );
      if (lateCancellation !== undefined) throw lateCancellation;
      throw new AdmissionDeniedError("provider_overrun");
    }
    if (lateCancellation !== undefined) throw lateCancellation;
    return response;
  } catch (error) {
    if (settled) {
      // Reconciliation/unknown-hold already reached an exactly-once terminal
      // state. Never overwrite it from a broad catch path.
    } else if (dispatched) {
      client.holdUnknown(reservationId, "provider_call_failed_after_dispatch");
    } else {
      client.void(reservationId, "provider_call_failed_before_dispatch");
    }
    if (lateCancellation !== undefined) throw lateCancellation;
    throw error;
  } finally {
    // Durable cancel/abort marks usage unknown immediately, but it must not
    // admit replacement work while an abort-ignoring provider is still live.
    // This is intentionally separate from durable reconciliation and is
    // idempotent when reconcile/holdUnknown/void already released the slot.
    client.acknowledgeCompletion(reservationId);
  }
}
