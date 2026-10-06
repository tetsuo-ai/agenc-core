/**
 * Runtime dependency helpers for the compact service.
 *
 * Source snapshot: `src/services/compact/*` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 *
 * The dependency boundary deliberately stays strict-safe: no imports from
 * `runtime/src/agenc/**`, `runtime/src/tui/**`, attachments, or
 * session-memory implementation modules.
 */

import {
  createTokenAccountingRequest,
  estimateTokenAccountingRequest,
  type TokenAccountingResult,
} from "../../../llm/token-accounting.js";
import { readProviderFactoryOptions } from "../../../llm/provider.js";
import { readGeminiRuntimeOptions } from "../../../llm/providers/gemini/runtime-options.js";
import type { LLMMessage } from "../../../llm/types.js";
import { fromRuntimeMessageContent } from "../../../llm/content-conversion.js";
export { lookupContextWindowForModel, positiveInteger, positiveNumber, isTruthyEnv } from "./limits.js";
import type { CompactContext, RuntimeMessage } from "../types.js";

export function estimateMessagesTokens(
  messages: readonly RuntimeMessage[],
  context?: CompactContext,
  options: { readonly inputOnly?: boolean } = {},
): number {
  const provider = context?.provider?.name ?? "unknown";
  const model = context?.options?.mainLoopModel ?? "unknown";
  const factoryOptions = context?.provider
    ? readProviderFactoryOptions(context.provider)
    : undefined;
  const providerExtra = factoryOptions?.extra ?? {};
  const configuredSystemPrompt =
    typeof providerExtra.systemPrompt === "string"
      ? providerExtra.systemPrompt
      : undefined;
  const configuredCachedContent =
    provider === "gemini"
      ? readGeminiRuntimeOptions(providerExtra)?.cachedContent
      : undefined;
  const systemPrompt =
    context?.options?.systemPrompt ?? configuredSystemPrompt;
  const promptCacheKey =
    context?.options?.promptCacheKey ?? configuredCachedContent;
  const request = createTokenAccountingRequest({
    provider,
    model,
    messages: messages.map(toAccountingMessage),
    options: {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(context?.options?.tools !== undefined
        ? { tools: context.options.tools }
        : factoryOptions?.tools !== undefined
          ? { tools: factoryOptions.tools }
          : {}),
      ...(context?.options?.toolChoice !== undefined
        ? { toolChoice: context.options.toolChoice }
        : {}),
      ...(context?.options?.contextWindowTokens !== undefined
        ? { contextWindowTokens: context.options.contextWindowTokens }
        : {}),
      ...(context?.options?.maxOutputTokens !== undefined
        ? { maxOutputTokens: context.options.maxOutputTokens }
        : {}),
      ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
    },
    contextWindowTokens: context?.options?.contextWindowTokens,
    reservedOutputTokens: context?.options?.maxOutputTokens,
  });
  let result: TokenAccountingResult;
  try {
    result = estimateTokenAccountingRequest(request);
  } catch {
    return context?.options?.contextWindowTokens ?? Number.MAX_SAFE_INTEGER;
  }
  if (!result.admissible) {
    return context?.options?.contextWindowTokens ?? Number.MAX_SAFE_INTEGER;
  }
  return options.inputOnly === true ? result.inputTokens : result.totalTokens;
}

export function messageText(message: RuntimeMessage): string {
  return stringifyContent(message.message?.content ?? message.content ?? "");
}

export function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function toAccountingMessage(message: RuntimeMessage): LLMMessage {
  const role =
    message.originalRole ??
    message.role ??
    (message.message?.role === "system" ||
    message.message?.role === "developer" ||
    message.message?.role === "user" ||
    message.message?.role === "assistant" ||
    message.message?.role === "tool"
      ? message.message.role
      : "user");
  const content = fromRuntimeMessageContent(
    message.message?.content ?? message.content ?? "",
  );
  return {
    role,
    content: content as LLMMessage["content"],
    ...(message.toolCallId !== undefined
      ? { toolCallId: message.toolCallId }
      : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.toolCalls !== undefined
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? "{}",
          })),
        }
      : {}),
    ...(message.runtimeOnly !== undefined
      ? { runtimeOnly: { ...message.runtimeOnly } }
      : {}),
    // Admission accounts the original LLMMessage, so every field it charges must
    // survive this projection or the auto-compaction gate measures less than
    // admission will (#2520). `phase` is an open string here and a two-value
    // union on LLMMessage, so it is narrowed rather than cast.
    ...(message.providerReasoningContent !== undefined
      ? { providerReasoningContent: message.providerReasoningContent }
      : {}),
    ...(message.providerReasoningProvenance !== undefined
      ? { providerReasoningProvenance: message.providerReasoningProvenance }
      : {}),
    ...(message.phase === "commentary" || message.phase === "final_answer"
      ? { phase: message.phase }
      : {}),
  };
}
