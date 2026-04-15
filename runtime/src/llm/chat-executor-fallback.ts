/**
 * Provider fallback call logic extracted from ChatExecutor.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMProvider,
  LLMMessage,
  LLMStatefulResumeAnchor,
  LLMStreamChunk,
  LLMToolChoice,
  StreamProgressCallback,
} from "./types.js";
import {
  LLMProviderError,
  LLMRateLimitError,
  classifyLLMFailure,
} from "./errors.js";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";
import { assertValidLLMResponse } from "./response-validation.js";
import {
  applyPromptBudget,
  type PromptBudgetConfig,
  type PromptBudgetSection,
} from "./prompt-budget.js";
import type { LLMRetryPolicyMatrix } from "./policy.js";
import type {
  ChatExecuteParams,
  ChatCallUsageRecord,
  CooldownEntry,
  FallbackResult,
} from "./chat-executor-types.js";
import {
  shouldRetryProviderImmediately,
  shouldFallbackForFailureClass,
  computeProviderCooldownMs,
  buildActiveCooldownSnapshot,
  emitProviderTraceEvent,
  maybeInjectProviderFault,
} from "./chat-executor-provider-retry.js";
import {
  estimatePromptShape,
} from "./chat-executor-text.js";
import { normalizeMessagesForAPI } from "./messages.js";
import { getProviderRouteKey } from "./model-routing-policy.js";
import { stripRuntimeOnlyPromptMetadata } from "./prompt-envelope.js";
import type { RuntimeFaultInjector } from "../eval/fault-injection.js";

// ============================================================================
// Helper
// ============================================================================

function shouldBypassStreamingForModelCall(
  options: LLMChatOptions | undefined,
  callPhase: ChatCallUsageRecord["phase"] | undefined,
  disableStreaming: boolean | undefined,
): boolean {
  if (disableStreaming === true) {
    return true;
  }
  const isExplicitToolTurn =
    options?.toolChoice === "required" ||
    (typeof options?.toolChoice === "object" &&
      options.toolChoice !== null &&
      options.toolChoice.type === "function");
  if (callPhase === "tool_followup" && isExplicitToolTurn) {
    return true;
  }
  if (!options?.toolRouting?.allowedToolNames) {
    return false;
  }
  if (options.toolRouting.allowedToolNames.length !== 1) {
    return false;
  }
  return isExplicitToolTurn;
}

function createRequestDeadlineExceededError(
  callPhase: ChatCallUsageRecord["phase"] | undefined,
  requestTimeoutMs: number | undefined,
): RuntimeError {
  const stage = callPhase ? `${callPhase} model call` : "model call";
  const normalizedTimeoutMs =
    typeof requestTimeoutMs === "number" &&
    Number.isFinite(requestTimeoutMs) &&
    requestTimeoutMs > 0
      ? Math.floor(requestTimeoutMs)
      : undefined;
  return new RuntimeError(
    normalizedTimeoutMs === undefined
      ? `Request exceeded end-to-end timeout during ${stage}`
      : `Request exceeded end-to-end timeout (${normalizedTimeoutMs}ms) during ${stage}`,
    RuntimeErrorCodes.LLM_TIMEOUT,
  );
}

// ============================================================================
// Configuration interface for callWithFallback
// ============================================================================

interface CallWithFallbackDeps {
  readonly providers: readonly LLMProvider[];
  readonly cooldowns: Map<string, CooldownEntry>;
  readonly promptBudget: PromptBudgetConfig;
  readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  readonly cooldownMs: number;
  readonly maxCooldownMs: number;
}

interface CallWithFallbackOptions {
  statefulSessionId?: string;
  statefulResumeAnchor?: LLMStatefulResumeAnchor;
  statefulHistoryCompacted?: boolean;
  reconciliationMessages?: readonly LLMMessage[];
  routedToolNames?: readonly string[];
  toolChoice?: LLMToolChoice;
  /**
   * Pre-Phase-F behavior: the class wrapper accepted this field but
   * the module silently dropped it before handing `baseChatOptions`
   * to the provider. Kept on the type so explicit call sites still
   * type-check; threading it through is tracked as a separate bug
   * out of scope for the Phase F refactor.
   */
  parallelToolCalls?: boolean;
  structuredOutput?: LLMChatOptions["structuredOutput"];
  requestDeadlineAt?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  trace?: ChatExecuteParams["trace"];
  callIndex?: number;
  callPhase?: ChatCallUsageRecord["phase"];
  faultInjector?: RuntimeFaultInjector;
  disableStreaming?: boolean;
}

// ============================================================================
// callWithFallback
// ============================================================================

/**
 * Call LLM providers with fallback and cooldown management.
 */
export async function callWithFallback(
  deps: CallWithFallbackDeps,
  messages: readonly LLMMessage[],
  onStreamChunk?: StreamProgressCallback,
  messageSections?: readonly PromptBudgetSection[],
  options?: CallWithFallbackOptions,
): Promise<FallbackResult> {
  const callStartedAt = Date.now();
  const beforeBudget = estimatePromptShape(messages);
  const budgeted = applyPromptBudget(
    messages.map((message, index) => ({
      message,
      section: messageSections?.[index],
    })),
    deps.promptBudget,
  );
  // Cut 5.8: pass the budgeted history through normalizeMessagesForAPI
  // before handing it to the provider. This drops boundary/snip system
  // messages, merges consecutive user messages, and drops empty
  // assistant content (except the last message). Orphan tool results
  // stay in the history here so downstream tool-turn repair can
  // close the protocol instead of silently discarding evidence.
  const boundedMessages: LLMMessage[] = [
    ...normalizeMessagesForAPI(budgeted.messages, {
      dropOrphanToolMessages: false,
    }),
  ];
  const serializedBoundedMessages = [
    ...stripRuntimeOnlyPromptMetadata(boundedMessages),
  ];
  const afterBudget = estimatePromptShape(boundedMessages);
  const budgetDiagnostics = budgeted.diagnostics;
  const hasStatefulSessionId = Boolean(options?.statefulSessionId);
  const hasStatefulResumeAnchor =
    hasStatefulSessionId && options?.statefulResumeAnchor !== undefined;
  const hasStatefulHistoryCompacted =
    hasStatefulSessionId && options?.statefulHistoryCompacted === true;
  const hasRoutedToolNames = options?.routedToolNames !== undefined;
  const hasToolChoice = options?.toolChoice !== undefined;
  const hasStructuredOutput = options?.structuredOutput !== undefined;
  const hasAbortSignal = options?.signal !== undefined;
  const hasProviderTrace =
    options?.trace?.includeProviderPayloads === true ||
    options?.trace?.onProviderTraceEvent !== undefined;
  const baseChatOptions: LLMChatOptions | undefined =
    hasStatefulSessionId ||
      hasRoutedToolNames ||
      hasToolChoice ||
      hasStructuredOutput ||
      hasAbortSignal ||
      hasProviderTrace
      ? {
        ...(hasStatefulSessionId
          ? {
            stateful: {
              sessionId: String(options?.statefulSessionId),
              reconciliationMessages:
                stripRuntimeOnlyPromptMetadata(
                  options?.reconciliationMessages ?? messages,
                ),
              ...(hasStatefulHistoryCompacted
                ? { historyCompacted: true }
                : {}),
              ...(hasStatefulResumeAnchor
                ? { resumeAnchor: options?.statefulResumeAnchor }
                : {}),
            },
          }
          : {}),
        ...(hasRoutedToolNames
          ? { toolRouting: { allowedToolNames: options?.routedToolNames } }
          : {}),
        ...(hasToolChoice ? { toolChoice: options?.toolChoice } : {}),
        ...(hasStructuredOutput
          ? { structuredOutput: options?.structuredOutput }
          : {}),
        ...(hasAbortSignal ? { signal: options?.signal } : {}),
        ...(hasProviderTrace
          ? {
            trace: {
              includeProviderPayloads:
                options?.trace?.includeProviderPayloads === true,
              ...(options?.trace?.onProviderTraceEvent
                ? {
                  onProviderTraceEvent: (event: Parameters<NonNullable<NonNullable<LLMChatOptions["trace"]>["onProviderTraceEvent"]>>[0]) =>
                    emitProviderTraceEvent(options, event),
                }
                : {}),
            },
          }
          : {}),
      }
      : undefined;
  let lastError: Error | undefined;
  const transport =
    onStreamChunk !== undefined &&
    !shouldBypassStreamingForModelCall(
      baseChatOptions,
      options?.callPhase,
      options?.disableStreaming,
    )
      ? "chat_stream"
      : "chat";

  const skipReasons: string[] = [];
  for (let i = 0; i < deps.providers.length; i++) {
    const provider = deps.providers[i];
    const providerRouteKey = getProviderRouteKey(provider);
    const now = Date.now();
    const cooldown = deps.cooldowns.get(providerRouteKey);

    if (cooldown && cooldown.availableAt > now) {
      skipReasons.push(
        `${provider.name}: cooldown until ${new Date(cooldown.availableAt).toISOString()} (${cooldown.failures} failures, ${Math.max(0, cooldown.availableAt - now)}ms remaining)`,
      );
      emitProviderTraceEvent(options, {
        kind: "error",
        transport,
        provider: provider.name,
        payload: {
          reason: "provider_cooldown_skip",
          retryAfterMs: Math.max(0, cooldown.availableAt - now),
          availableAt: cooldown.availableAt,
          failures: cooldown.failures,
        },
        context: {
          stage: "fallback_selection",
        },
      });
      continue;
    }

    let attempts = 0;
    while (true) {
      try {
        let streamedContent = "";
        const streamChunkCallback = onStreamChunk
          ? (chunk: LLMStreamChunk) => {
            if (chunk.content.length > 0) {
              streamedContent += chunk.content;
            }
            onStreamChunk(chunk);
          }
          : undefined;
        const shouldStream =
          transport === "chat_stream" && streamChunkCallback !== undefined;
        const remainingProviderMs =
          options?.requestDeadlineAt !== undefined &&
            Number.isFinite(options.requestDeadlineAt)
            ? options.requestDeadlineAt - Date.now()
            : undefined;
        if (remainingProviderMs !== undefined && remainingProviderMs <= 0) {
          throw createRequestDeadlineExceededError(
            options?.callPhase,
            options?.requestTimeoutMs,
          );
        }
        const providerChatOptions: LLMChatOptions | undefined =
          baseChatOptions || remainingProviderMs !== undefined
            ? {
              ...(baseChatOptions ?? {}),
              ...(remainingProviderMs !== undefined
                ? { timeoutMs: Math.max(1, Math.floor(remainingProviderMs)) }
                : {}),
            }
            : undefined;
        maybeInjectProviderFault(options?.faultInjector, {
          provider: provider.name,
          stage: transport,
        });
        const rawResponse = shouldStream
          ? await provider.chatStream(
            serializedBoundedMessages,
            streamChunkCallback,
            providerChatOptions,
          )
          : await provider.chat(serializedBoundedMessages, providerChatOptions);
        const response = assertValidLLMResponse(provider.name, rawResponse);

        if (response.finishReason === "error") {
          throw (
            response.error ??
            new LLMProviderError(provider.name, "Provider returned error")
          );
        }

        // Success — clear cooldown
        const priorCooldown = deps.cooldowns.get(providerRouteKey);
        deps.cooldowns.delete(providerRouteKey);
        if (priorCooldown) {
          emitProviderTraceEvent(options, {
            kind: "response",
            transport,
            provider: provider.name,
            model: response.model,
            payload: {
              reason: "provider_cooldown_cleared",
              failures: priorCooldown.failures,
              previousAvailableAt: priorCooldown.availableAt,
            },
            context: {
              stage: "fallback_selection",
            },
          });
        }

        return {
          response,
          providerName: provider.name,
          usedFallback: i > 0,
          durationMs: Math.max(1, Date.now() - callStartedAt),
          beforeBudget,
          afterBudget,
          budgetDiagnostics,
          streamedContent,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const failureClass = classifyLLMFailure(lastError);
        const retryRule = deps.retryPolicyMatrix[failureClass];

        if (
          shouldRetryProviderImmediately(
            failureClass,
            retryRule,
            lastError,
            attempts,
          )
        ) {
          attempts++;
          continue;
        }

        if (!shouldFallbackForFailureClass(failureClass, lastError)) {
          throw lastError;
        }

        // Apply cooldown for this provider before trying fallbacks.
        const failures =
          (deps.cooldowns.get(providerRouteKey)?.failures ?? 0) + 1;
        const cooldownDuration = computeProviderCooldownMs(
          failures,
          retryRule,
          lastError,
          deps.cooldownMs,
          deps.maxCooldownMs,
        );
        const availableAt = Date.now() + cooldownDuration;
        deps.cooldowns.set(providerRouteKey, {
          availableAt,
          failures,
        });
        emitProviderTraceEvent(options, {
          kind: "error",
          transport,
          provider: provider.name,
          payload: {
            reason: "provider_cooldown_applied",
            failureClass,
            retryAfterMs: cooldownDuration,
            cooldownDurationMs: cooldownDuration,
            availableAt,
            failures,
            errorName: lastError.name,
            errorMessage: lastError.message,
            ...(lastError instanceof LLMProviderError &&
            lastError.statusCode !== undefined
              ? { statusCode: lastError.statusCode }
              : {}),
            ...(lastError instanceof LLMRateLimitError &&
            lastError.retryAfterMs !== undefined
              ? { providerRetryAfterMs: lastError.retryAfterMs }
              : {}),
          },
          context: {
            stage: "fallback_selection",
            attempts,
          },
        });
        break;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  const now = Date.now();
  emitProviderTraceEvent(options, {
    kind: "error",
    transport,
    provider: "chat-executor",
    payload: {
      reason: "all_providers_in_cooldown",
      providers: buildActiveCooldownSnapshot(deps.cooldowns, now),
    },
    context: {
      stage: "fallback_selection",
    },
  });
  // All providers were skipped (in cooldown) — no provider was attempted
  throw new LLMProviderError(
    "chat-executor",
    `All providers are in cooldown${skipReasons.length > 0 ? `: ${skipReasons.join("; ")}` : ""}`,
  );
}
