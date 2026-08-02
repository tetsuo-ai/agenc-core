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
import type { LLMMessage } from "../../../llm/types.js";
import {
  OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW,
  getOpenAICompatibleContextWindow,
} from "../../../llm/openai-compatible-token-limits.js";
import type { CompactContext, RuntimeMessage } from "../types.js";

/**
 * Model-string → context-window lookup, used as a last-resort fallback
 * when neither the live `CompactContext.options.contextWindowTokens`
 * nor the `AGENC_AUTO_COMPACT_WINDOW` env override is available.
 *
 * Three layers:
 *   1. Family-literal shortcuts for haiku/sonnet/opus (→ 200k) — kept
 *      for backward compatibility with callers that pass a known
 *      family id directly.
 *   2. The shared {@link getOpenAICompatibleContextWindow} table —
 *      covers qwen, llama, gemma, mistral, deepseek, gpt-*, gemini,
 *      glm, kimi, etc. with explicit per-model windows.
 *   3. {@link OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW} (128k) for
 *      truly unknown models. The previous fallback (32k) was a stale
 *      haiku-era default that quietly shrank the window of every
 *      provider whose model id didn't match haiku/sonnet/opus; 128k
 *      matches the openai-compat table's documented unknown-model
 *      assumption.
 */
export function lookupContextWindowForModel(model: string | undefined): number {
  if (model === undefined || model.trim().length === 0) {
    return OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW;
  }
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return 200_000;
  if (normalized.includes("sonnet")) return 200_000;
  if (normalized.includes("opus")) return 200_000;
  const tableHit = getOpenAICompatibleContextWindow(model);
  if (tableHit !== undefined) return tableHit;
  return OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW;
}

export function estimateMessagesTokens(
  messages: readonly RuntimeMessage[],
  context?: CompactContext,
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
    provider === "gemini" && typeof providerExtra.cachedContent === "string"
      ? providerExtra.cachedContent
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
  return result.totalTokens;
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

export function positiveInteger(value: string | undefined): number | undefined {
  const parsed = positiveNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

export function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
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
  const content = message.message?.content ?? message.content ?? "";
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
  };
}
