/** Shared M3 boundary for logical model calls. */

import type { Session } from "../session/session.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMProviderExecutionProfile,
  LLMResponse,
} from "../llm/types.js";
import {
  readProviderFactoryOptions,
  type ProviderFactoryOptions,
  type ProviderRuntimeExtra,
} from "../llm/provider.js";
import { readGeminiRuntimeOptions } from "../llm/providers/gemini/runtime-options.js";
import { getProviderNativeToolDefinitions } from "../llm/provider-native-search.js";
import {
  createTokenAccountingConfigurationRevision,
  createTokenAccountingRequest,
  tokenAccountingService,
  type TokenAccountingResult,
} from "../llm/token-accounting.js";
import { getContextWindowForModel } from "../utils/context.js";
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

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function accountingOptionsForProvider(
  provider: LLMProvider,
  factoryOptions: ProviderFactoryOptions,
  options: LLMChatOptions,
  contextWindowTokens: number,
): LLMChatOptions {
  const extra = factoryOptions.extra ?? {};
  const configuredSystemPrompt =
    typeof extra.systemPrompt === "string" ? extra.systemPrompt : undefined;
  const configuredTemperature =
    typeof extra.temperature === "number" ? extra.temperature : undefined;
  const configuredCachedContent =
    provider.name === "gemini"
      ? readGeminiRuntimeOptions(extra)?.cachedContent
      : undefined;
  return {
    ...options,
    contextWindowTokens,
    ...(options.systemPrompt === undefined &&
    configuredSystemPrompt !== undefined
      ? { systemPrompt: configuredSystemPrompt }
      : {}),
    ...(options.tools === undefined && factoryOptions.tools !== undefined
      ? { tools: factoryOptions.tools }
      : {}),
    ...(options.temperature === undefined && configuredTemperature !== undefined
      ? { temperature: configuredTemperature }
      : {}),
    ...(options.promptCacheKey === undefined &&
    configuredCachedContent !== undefined
      ? { promptCacheKey: configuredCachedContent }
      : {}),
  };
}

function providerNativeToolsForAccounting(
  provider: LLMProvider,
  providerName: string,
  model: string,
  extra: ProviderRuntimeExtra,
  options: LLMChatOptions,
): readonly Readonly<Record<string, unknown>>[] {
  if (provider.name !== "grok" && providerName !== "grok") return [];
  const definitions = getProviderNativeToolDefinitions({
    provider: "grok",
    model,
    ...(extra.webSearch !== undefined ? { webSearch: extra.webSearch } : {}),
    ...(extra.searchMode !== undefined ? { searchMode: extra.searchMode } : {}),
    ...(extra.webSearchOptions !== undefined
      ? { webSearchOptions: extra.webSearchOptions }
      : {}),
    ...(extra.xSearch !== undefined ? { xSearch: extra.xSearch } : {}),
    ...(extra.xSearchOptions !== undefined
      ? { xSearchOptions: extra.xSearchOptions }
      : {}),
    ...(extra.codeExecution !== undefined
      ? { codeExecution: extra.codeExecution }
      : {}),
    ...(extra.collectionsSearch !== undefined
      ? { collectionsSearch: extra.collectionsSearch as never }
      : {}),
    ...(extra.remoteMcp !== undefined
      ? { remoteMcp: extra.remoteMcp as never }
      : {}),
  });
  const allowedToolNames = options.toolRouting?.allowedToolNames;
  const selectedDefinitions =
    allowedToolNames === undefined
      ? options.toolChoice === "none"
        ? []
        : definitions
      : (() => {
          const allowed = new Set(
            allowedToolNames
              .map((name) => name.trim())
              .filter((name) => name.length > 0),
          );
          return definitions.filter(({ name }) => allowed.has(name));
        })();
  return selectedDefinitions.map(({ name, toolType, payload }) => ({
    name,
    toolType,
    payload,
  }));
}

/**
 * Strip a cross-provider "provider:model" prefix down to the provider-local
 * model slug. Only an exact, case-insensitive match of the resolved provider
 * name is stripped; colons inside provider-local ids are preserved.
 */
export function providerLocalModelSlug(
  model: string,
  provider: string,
): string {
  const prefix = `${provider}:`;
  if (
    provider.length > 0 &&
    model.length > prefix.length &&
    model.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
  ) {
    return model.slice(prefix.length);
  }
  return model;
}

function pricedEntry(model: string, provider: string): ModelCostEntry | null {
  const resolved = resolveModelCostEntry(
    { model, provider },
    DEFAULT_MODEL_COSTS,
  );
  if (resolved === null) return null;
  const entry = resolved.entry;
  // Entries explicitly declared localZeroCost are the registry's statement
  // that this provider bills nothing. Treating them as unpriced held every
  // successful ollama/lmstudio response in
  // `held_unknown(unpriced_provider_response)` and denied local model calls
  // under hard USD caps (#1752).
  if (entry.localZeroCost === true) return entry;
  const rates = [
    entry.inputUsdPer1K,
    entry.outputUsdPer1K,
    entry.cachedInputUsdPer1K ?? 0,
    entry.cacheCreationUsdPer1K ?? 0,
    entry.reasoningOutputUsdPer1K ?? 0,
    entry.webSearchUsdPerRequest ?? 0,
  ];
  // A zero-rate entry without the explicit local label does not prove that an
  // arbitrary provider/model alias is free. Keep hard USD caps fail-closed.
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
    serverTools.some((name) => name !== "web_search" && name !== "x_search")
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
/**
 * Whether a provider-reported model id names the model we asked for.
 *
 * Local servers answer with their own canonical id: ask LM Studio for
 * `unsloth/qwen3.8-27b` and it replies `qwen3.8-27b`. Compared as raw
 * strings that reads as the provider silently switching models, which
 * books a fallback against a step that already exists and kills the turn
 * with AdmissionStepConflictError — the user sees an empty answer.
 * Vendor prefix and case are not identity.
 */
function isSameModelIdentity(reported: string, requested: string): boolean {
  const normalize = (value: string): string =>
    value.trim().toLowerCase().split("/").pop() ?? value.trim().toLowerCase();
  if (reported.trim().toLowerCase() === requested.trim().toLowerCase()) {
    return true;
  }
  return normalize(reported) === normalize(requested);
}

export async function runAdmittedModelCall(
  params: AdmittedModelCallOptions,
): Promise<LLMResponse> {
  const client = params.session.services.executionAdmission;
  const providerFactoryOptions = readProviderFactoryOptions(params.provider);
  // A few structurally typed embedding/test providers predate the explicit
  // identity fields on this boundary. Keep the admission path fail-safe at
  // runtime by resolving the same concrete identity from request, factory,
  // session, and provider data instead of dereferencing an unchecked cast.
  const requestedProvider =
    nonBlankString(params.providerName) ??
    nonBlankString(params.provider.name) ??
    "unknown";
  const sessionModel = nonBlankString(params.session.modelInfo?.slug);
  // Config and recovery surfaces reference models in cross-provider
  // "provider:model" form. The admitted identity must be the provider-local
  // slug: it is what reaches the provider wire (ollama rejects a
  // "ollama:"-prefixed name outright), and it is the key for session
  // context-window and pricing lookups. Only an exact provider-name prefix is
  // stripped, so provider-local ids that legitimately contain colons (for
  // example "amazon.nova-pro-v1:0" or "qwen3-coder:30b") pass through.
  const requestedModel = providerLocalModelSlug(
    nonBlankString(params.model) ??
      nonBlankString(params.options.model) ??
      nonBlankString(providerFactoryOptions.model) ??
      sessionModel ??
      "unknown",
    requestedProvider,
  );

  const stagedFallbackEvent =
    params.fallback === undefined
      ? undefined
      : {
          stepId: params.stepId,
          fromModel: params.fallback.fromModel,
          toModel: requestedModel,
          ...(params.fallback.fromProvider !== undefined
            ? { fromProvider: params.fallback.fromProvider }
            : {}),
          toProvider: requestedProvider,
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
    if (stagedFallbackEvent !== undefined && client !== undefined) {
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
    routedProvider !== requestedProvider;
  const effectiveProvider = usesConcreteExecutionIdentity
    ? routedProvider
    : requestedProvider;
  const effectiveModel =
    usesConcreteExecutionIdentity && profile?.model?.trim()
      ? providerLocalModelSlug(profile.model.trim(), effectiveProvider)
      : requestedModel;
  const configuredMaxOutputTokens =
    positiveInteger(params.options.maxOutputTokens) ??
    positiveInteger(profile?.maxOutputTokens);
  // A denied preflight still enters the durable admission API. Zero is only
  // a persisted placeholder for the rejected request; it never reaches a
  // provider because denialReason is resolved before queue/claim.
  const maxOutputTokens = configuredMaxOutputTokens ?? 0;
  const hasHardCostCap =
    client?.scope.hasHardCostCap === true ||
    client?.scope.maxCostUsd !== undefined;
  const hasHardTokenCap =
    client?.scope.hasHardTokenCap === true ||
    client?.scope.maxTokens !== undefined;
  // Under a hard aggregate token/USD cap the reservation must be a real
  // upper bound, so the provider has to enforce the request-scoped output
  // ceiling and report authoritative usage. Without a hard cap that
  // requirement would brick every provider that cannot accept an output
  // ceiling at all — the ChatGPT subscription backend rejects
  // max_output_tokens by design — so uncapped calls admit as before and
  // their usage is conservatively held unknown after dispatch.
  const providerContractUnavailable =
    (hasHardCostCap || hasHardTokenCap) &&
    (profile?.supportsMaxOutputTokens !== true ||
      profile.usageReporting !== "authoritative");

  const contextWindowTokens =
    positiveInteger(params.options.contextWindowTokens) ??
    positiveInteger(profile?.contextWindowTokens) ??
    (sessionModel === effectiveModel
      ? positiveInteger(params.session.modelInfo?.contextWindow)
      : undefined) ??
    getContextWindowForModel(effectiveModel);
  const accountingOptions = accountingOptionsForProvider(
    params.provider,
    providerFactoryOptions,
    {
      ...params.options,
      model: effectiveModel,
      ...(configuredMaxOutputTokens !== undefined
        ? { maxOutputTokens: configuredMaxOutputTokens }
        : {}),
      ...(profile?.providerExecutionHandle !== undefined
        ? { providerExecutionHandle: profile.providerExecutionHandle }
        : {}),
    },
    contextWindowTokens,
  );
  const providerNativeTools = providerNativeToolsForAccounting(
    params.provider,
    effectiveProvider,
    effectiveModel,
    providerFactoryOptions.extra ?? {},
    accountingOptions,
  );
  const accountingRequest = createTokenAccountingRequest({
    provider: effectiveProvider,
    model: effectiveModel,
    messages: params.messages,
    options: accountingOptions,
    ...(providerNativeTools.length > 0 ? { providerNativeTools } : {}),
    endpointIdentity: providerFactoryOptions.baseURL,
    configurationRevision: createTokenAccountingConfigurationRevision({
      systemPrompt: accountingOptions.systemPrompt ?? "",
      tools: accountingOptions.tools ?? [],
      temperature: accountingOptions.temperature ?? null,
      providerNativeTools,
      contextWindowTokens,
      maxOutputTokens,
    }),
    contextWindowTokens,
    reservedOutputTokens: maxOutputTokens,
  });
  let accountingResult: TokenAccountingResult | undefined;
  let accountingFailureReason: string | undefined;
  try {
    accountingResult = await tokenAccountingService.count(accountingRequest, {
      ...(params.provider.tokenCountCapability !== undefined
        ? { capability: params.provider.tokenCountCapability }
        : {}),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
    if (!accountingResult.admissible) {
      accountingFailureReason = "token_accounting_uncertain";
    } else if (accountingResult.totalTokens > contextWindowTokens) {
      accountingFailureReason = "context_window_exceeded";
    }
  } catch (error) {
    if (params.signal?.aborted === true) {
      throw params.signal.reason ?? error;
    }
    accountingFailureReason = "token_accounting_unavailable";
  }
  const countedInputTokens = accountingResult?.inputTokens ?? 0;
  // Provider-native server tools (web_search, x_search, code_interpreter,
  // file_search, mcp) execute on the provider side and feed their results back
  // into the same turn's context. Token accounting can only count the messages
  // this process sends, so the counted total systematically under-states the
  // real input for these turns: an observed web_search reserved 2,565 tokens
  // and reported 10,104, and reservations of ~2.6k against reported 48k-53k
  // are routine. Reconciliation then sees actualTokens > reserved_tokens,
  // flags provider_overrun, and sets blocked_by_provider_overrun on the
  // allocation, which cancels every later step in the run. A single search
  // takes down the whole session.
  //
  // The provider cannot feed back more than the context window, so that is the
  // true upper bound for these turns. Reserve it instead of the uncountable
  // estimate. This only widens the reservation; the authoritative reported
  // usage is still what gets charged at reconciliation.
  const maxInputTokens =
    hasUnboundedPaidServerTool(accountingOptions) &&
    contextWindowTokens > countedInputTokens
      ? contextWindowTokens
      : countedInputTokens;
  const unboundedPaidServerTool =
    hasHardCostCap && hasUnboundedPaidServerTool(accountingOptions);
  const maximumCost = maximumTokenCostUsd(
    effectiveModel,
    effectiveProvider,
    maxInputTokens,
    maxOutputTokens,
    accountingOptions,
  );
  const denialReason =
    accountingFailureReason ??
    (configuredMaxOutputTokens === undefined
      ? "unbounded_model_output"
      : providerContractUnavailable
        ? "provider_budget_contract_unavailable"
        : unboundedPaidServerTool
          ? "unbounded_provider_tool_under_hard_cap"
          : hasHardCostCap && maximumCost === null
            ? "unpriced_model_under_hard_cap"
            : undefined);
  if (client === undefined) {
    if (params.session.services.admissionRequired !== false) {
      throw new AdmissionDeniedError("admission_kernel_unavailable");
    }
    if (accountingFailureReason !== undefined) {
      throw new AdmissionDeniedError(accountingFailureReason);
    }
    return params.invoke({
      ...accountingOptions,
      ...(accountingResult !== undefined
        ? { accountedInputTokens: accountingResult.inputTokens }
        : {}),
    });
  }
  const fallbackEvent =
    stagedFallbackEvent === undefined
      ? undefined
      : {
          ...stagedFallbackEvent,
          toModel: effectiveModel,
          toProvider: effectiveProvider,
        };
  const routingEvent = usesConcreteExecutionIdentity
    ? {
        stepId: params.stepId,
        fromModel: requestedModel,
        toModel: effectiveModel,
        fromProvider: requestedProvider,
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
        tokenAccountingSource: accountingResult?.source,
        tokenAccountingConfidence: accountingResult?.confidence,
        tokenAccountingCoverageComplete: accountingResult?.coverage.complete,
      },
    });
    dispatched = true;
    const response = await params.invoke({
      ...accountingOptions,
      ...(profile?.providerExecutionHandle !== undefined
        ? { providerExecutionHandle: profile.providerExecutionHandle }
        : {}),
      // A retry or continuation fallback is a new wire attempt and therefore
      // requires a new durable reservation. Adapters must surface the error
      // to the caller instead of retrying beneath this lease.
      singleWireAttempt: true,
      ...(accountingResult !== undefined
        ? { accountedInputTokens: accountingResult.inputTokens }
        : {}),
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
    if (
      response.model !== "" &&
      !isSameModelIdentity(response.model, effectiveModel)
    ) {
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
    if (accountingResult !== undefined) {
      tokenAccountingService.recordProviderUsage(
        accountingResult,
        reconciled.inputTokens,
      );
    }
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
