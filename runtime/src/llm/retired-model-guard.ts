/**
 * No request is ever sent for a model its provider has retired.
 *
 * Selection refuses a typed choice of a retired model. A saved choice still
 * starts, so its owner can open AgenC and pick another model, and is told why
 * (bin/startup-selection.ts). This is the last check: every provider the
 * factory makes refuses a request for a retired model before anything reaches
 * the wire, with the same plain message, whatever path the request takes (a
 * saved or restored session, a profile, a subagent, a fork). The rule is
 * retiredModelNotice's: the bundled date has arrived and the provider's own
 * list in this process does not say otherwise. NVIDIA's dates bind its hosted
 * API only, as at selection.
 *
 * @module
 */

import { LLMModelRetiredError, markLLMPreGenerationRejection } from "./errors.js";
import { retiredModelNotice } from "./model-catalog-selection.js";
import { hasCustomProviderBaseUrl } from "./model-metadata.js";
import { resolveBuiltInProviderSlug } from "./registry/provider-info.js";
import type { LLMProvider } from "./types.js";

/**
 * Make `provider` refuse every model request for a retired model: the model
 * the request names (a skill turn names its own, `LLMChatOptions.model`), or
 * else the one the provider was made for. The date is read at each request,
 * so a session that outlives the date stops sending from that day on. The
 * refusal is marked as a rejection before generation: an admitted call
 * settles it at zero usage.
 */
export function refuseRetiredModelRequests<T extends LLMProvider>(
  provider: T,
  providerName: string,
  model: string | undefined,
  baseURL: string | undefined,
): T {
  const slug = resolveBuiltInProviderSlug(providerName);
  if (slug === undefined) return provider;
  // A self-hosted NIM serves whatever it runs (providerRetirementApplies).
  if (slug === "nvidia-nim" && hasCustomProviderBaseUrl(slug, baseURL)) return provider;
  const refusal = (requestModel: string | undefined): LLMModelRetiredError | undefined => {
    const id = requestModel?.trim() || model?.trim();
    if (id === undefined || id.length === 0) return undefined;
    const notice = retiredModelNotice(slug, id);
    return notice === undefined
      ? undefined
      : markLLMPreGenerationRejection(new LLMModelRetiredError(slug, id, notice), slug);
  };
  const chat = provider.chat;
  provider.chat = async function (...args: Parameters<LLMProvider["chat"]>) {
    const refused = refusal(args[1]?.model);
    if (refused !== undefined) throw refused;
    return chat.apply(this, args);
  };
  const chatStream = provider.chatStream;
  if (chatStream !== undefined) {
    provider.chatStream = async function (...args: Parameters<LLMProvider["chatStream"]>) {
      const refused = refusal(args[2]?.model);
      if (refused !== undefined) throw refused;
      return chatStream.apply(this, args);
    };
  }
  // A startup prewarm may open the provider's connection ahead of the first
  // request; a retired model opens none.
  const prewarmStartup = provider.prewarmStartup;
  if (prewarmStartup !== undefined) {
    (provider as { prewarmStartup?: LLMProvider["prewarmStartup"] }).prewarmStartup = function (
      this: T,
      ...args: Parameters<NonNullable<LLMProvider["prewarmStartup"]>>
    ) {
      return refusal(undefined) === undefined ? prewarmStartup.apply(this, args) : undefined;
    };
  }
  return provider;
}
