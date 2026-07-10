/**
 * Per-provider capability gating for chat-completions wire fields.
 *
 * Some chat-completions request fields (`reasoning_effort`,
 * `service_tier`, `stream_options.include_usage`) are documented
 * cleanly only for one upstream provider, but the openai-compatible
 * base adapter is shared by every openai-compat provider in the
 * registry (lmstudio, ollama, openrouter, deepseek, groq, mistral,
 * nvidia-nim, github, minimax, …). Sending an unsupported field has
 * three failure modes:
 *
 *   1. Strict provider returns a 400 on unknown fields.
 *   2. Permissive provider silently ignores the field — no error,
 *      but the request is misshapen and behavior is undocumented.
 *   3. Some local servers (older Ollama versions, custom proxies)
 *      reject `stream_options` specifically and tear down the stream.
 *
 * This module centralizes the per-provider capability matrix so each
 * adapter doesn't have to spell out its own set of overrides. The
 * matrix keys on `normalizeProviderSlug(this.name)` from the base
 * adapter; subclasses don't need to override anything as long as they
 * pass a recognizable slug.
 */

import { normalizeProviderSlug } from "../capabilities.js";
import { supportsXaiReasoningEffortParam } from "../structured-output.js";

export interface ChatCompletionsCapabilityHints {
  /**
   * If `false`, `reasoning_effort` is stripped from the request body
   * even when the caller's options specify a value. If `true` or
   * `undefined`, current behavior is preserved (caller-controlled).
   */
  readonly acceptsReasoningEffort?: boolean;
  /**
   * If `false`, `service_tier` is stripped. The field is recognized
   * only on a single upstream provider; non-matching providers
   * either reject it or silently ignore it.
   */
  readonly acceptsServiceTier?: boolean;
  /**
   * If `false`, `stream_options.include_usage` is omitted from
   * streaming requests. Some local openai-compat servers reject the
   * field and tear down the stream on encounter.
   */
  readonly acceptsStreamUsage?: boolean;
}

// Providers that document `service_tier` on chat-completions.
// branding-scan: allow real provider identifiers in capability matrix
const SERVICE_TIER_PROVIDERS = new Set(["openai", "azure-openai"]);

// Providers explicitly known to reject `stream_options.include_usage`.
// Currently empty by design: the default is "include" because losing
// usage tracking on every streamed response is a significant
// regression. Only add a provider here when we have a reproducible
// failure case from a real installation. Override per-instance via
// the `providerCapabilityHints.acceptsStreamUsage` opt for one-off
// servers that misbehave.
const STREAM_USAGE_INCOMPATIBLE_PROVIDERS = new Set<string>();

/**
 * Lightweight test for the upstream-provider reasoning model family.
 * Mirrors the regex in `capabilities.ts:isOpenAIReasoningModel` so we
 * don't have to widen that file's exports for this single use site.
 */
function isUpstreamReasoningModel(model: string | undefined): boolean {
  if (model === undefined) return false;
  // branding-scan: allow real model-family identifiers in regex
  return /(?:^|[/:])(?:gpt-5|o1|o3|o4|codex|chatgpt-5)(?:$|[-_.:])/i.test(
    model.trim(),
  );
}

/**
 * Resolve the capability hints for a given provider slug + model.
 * Each adapter calls this when building a chat-completions request so
 * the wire layer can strip fields the destination provider rejects.
 */
export function chatCompletionsCapabilityHintsForProvider(
  providerName: string | undefined,
  model: string | undefined,
): ChatCompletionsCapabilityHints {
  const slug = normalizeProviderSlug(providerName);

  // reasoning_effort: documented for the upstream-provider reasoning
  // model family and for documented xAI Grok reasoning variants. Every
  // other provider/model combination either rejects it or silently
  // ignores it. Default to the safe "strip" for anything
  // unrecognized.
  // branding-scan: allow factual reference to real provider in routing comment
  let acceptsReasoningEffort = false;
  if (slug === "openai") {
    acceptsReasoningEffort = isUpstreamReasoningModel(model);
  } else if (slug === "grok") {
    acceptsReasoningEffort = supportsXaiReasoningEffortParam(model);
  }

  // service_tier: recognized by a single upstream provider. Strip
  // everywhere else — most servers ignore it silently, but at least
  // one custom proxy in the wild rejects unknown fields.
  const acceptsServiceTier = SERVICE_TIER_PROVIDERS.has(slug);

  // stream_options: accepted by most openai-compat providers. Strip
  // only for providers known to reject it. The runtime emits a
  // warning out-of-band when a streamed response carries no usage,
  // so dropping the field is a usability regression on the providers
  // that DO support it — keep the default permissive.
  const acceptsStreamUsage = !STREAM_USAGE_INCOMPATIBLE_PROVIDERS.has(slug);

  return {
    acceptsReasoningEffort,
    acceptsServiceTier,
    acceptsStreamUsage,
  };
}
