/**
 * How much of a session's input its providers served from their prompt
 * cache, for the status line ("cache 91%"). It reads the same `token_count`
 * usage the cost tracker prices, and asks no provider anything.
 *
 * @module
 */

import { BUILT_IN_PROVIDER_DEFINITIONS } from "../llm/registry/provider-info.js";
import { billableTokenUsage } from "../llm/usage.js";
import { normalizeProviderMetadataIdentity } from "../provider-identity.js";
import { reportsCacheOutsideInput } from "./cost.js";

export interface ProviderPromptCacheTotals {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  /** A call from this provider carried a cached-token count, zero included. */
  readonly reportsCache: boolean;
}

export interface PromptCacheTally {
  readonly providers: Readonly<Record<string, ProviderPromptCacheTotals>>;
  /** Provider of the latest call that reported usage. */
  readonly latestProvider: string | null;
}

export const EMPTY_PROMPT_CACHE_TALLY: PromptCacheTally = Object.freeze({
  providers: Object.freeze({}),
  latestProvider: null,
});

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

/** The tally after one `token_count` payload. The given tally is not changed. */
export function addPromptCacheUsage(
  tally: PromptCacheTally,
  payload: Readonly<Record<string, unknown>>,
): PromptCacheTally {
  const named = normalizeProviderMetadataIdentity(
    typeof payload.provider === "string" ? payload.provider : undefined,
  );
  const provider = named ?? "unknown";
  const cached = tokenCount(payload.cachedInputTokens);
  const cacheWrites = tokenCount(payload.cacheCreationInputTokens);
  const reasoning = tokenCount(payload.reasoningOutputTokens);
  // Every input token of the call, whichever way its wire counts cache.
  const { inputTokens } = billableTokenUsage({
    promptTokens: tokenCount(payload.promptTokens) ?? 0,
    completionTokens: tokenCount(payload.completionTokens) ?? 0,
    totalTokens: tokenCount(payload.totalTokens) ?? 0,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(cacheWrites !== undefined ? { cacheCreationInputTokens: cacheWrites } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
    ...(reportsCacheOutsideInput(provider) ? { cacheInputExcludedFromPrompt: true as const } : {}),
  });
  const before = tally.providers[provider];
  return {
    providers: {
      ...tally.providers,
      [provider]: {
        inputTokens: (before?.inputTokens ?? 0) + inputTokens,
        cachedInputTokens: (before?.cachedInputTokens ?? 0) + (cached ?? 0),
        reportsCache: before?.reportsCache === true || cached !== undefined,
      },
    },
    // A call without provider metadata (MCP sampling) does not switch it.
    latestProvider: named ?? tally.latestProvider ?? provider,
  };
}

/** A local runtime's cache reuse is not a provider's prompt cache. */
function isLocalProvider(provider: string): boolean {
  return Object.hasOwn(BUILT_IN_PROVIDER_DEFINITIONS, provider) &&
    BUILT_IN_PROVIDER_DEFINITIONS[provider as keyof typeof BUILT_IN_PROVIDER_DEFINITIONS]
      .onboarding.access === "local";
}

/**
 * Whole percent of the session's input served from cache, over the providers
 * that report cached tokens. Null hides it: before any call reports usage, and
 * while the latest call came from a local model or a provider that has never
 * reported a cached count.
 */
export function promptCacheSharePercent(tally: PromptCacheTally): number | null {
  const latest = tally.latestProvider;
  if (latest === null || isLocalProvider(latest) || tally.providers[latest]?.reportsCache !== true) {
    return null;
  }
  let inputTokens = 0;
  let cachedInputTokens = 0;
  for (const [provider, totals] of Object.entries(tally.providers)) {
    if (!totals.reportsCache || isLocalProvider(provider)) continue;
    inputTokens += totals.inputTokens;
    cachedInputTokens += totals.cachedInputTokens;
  }
  if (inputTokens === 0) return null;
  const percent = Math.round((Math.min(cachedInputTokens, inputTokens) / inputTokens) * 100);
  // 100 only when every input token was served from cache.
  return cachedInputTokens < inputTokens ? Math.min(percent, 99) : 100;
}
