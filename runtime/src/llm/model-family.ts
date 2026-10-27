/**
 * The model family behind a provider/model pair.
 *
 * AgenC tunes some behavior for a model family: Light's task limits and batch
 * Edit for DeepSeek, apply_patch for GPT, the DeepSeek shared-prefix prompt
 * layout and per-call output default. That tuning is keyed on the native
 * provider (`deepseek`, `openai`), so the same model reached through a gateway
 * that serves it under its own id (OpenRouter, Ollama Cloud, Venice) used to
 * miss it. This module maps those gateway ids and known abliteration builds
 * back to the family.
 *
 * The managed AgenC route and custom OpenAI-compatible endpoints are not
 * gateways here: the managed route carries its own reviewed contract and a
 * custom endpoint's id says nothing reliable about what it serves.
 *
 * @module
 */

import { normalizeProviderMetadataIdentity } from "../provider-identity.js";

export type ModelFamily = "deepseek" | "openai" | "kimi";

/** Gateways with model ids whose underlying family is known. */
export const MODEL_FAMILY_GATEWAYS: ReadonlySet<string> = new Set([
  "openrouter",
  "ollama-cloud",
  "venice",
  "abliteration",
]);

// GPT-5 and later, the o-series and Codex: the hosted reasoning models whose
// native route AgenC tunes. Open-weight gpt-oss models are served by
// third-party engines and are not part of the family.
const OPENAI_HOSTED_GPT = /^(?:gpt-(?:[5-9]|[1-9]\d)(?:$|[-_.:\d])|o[134](?:$|[-_.:])|codex(?:$|[-_.:])|chatgpt-[5-9])/u;
const DEEPSEEK = /^deepseek(?:$|[-_.:])/u;

function modelSlug(model: string): string {
  // OpenRouter routing variants (`:nitro`, `:floor`, `:free`) and alias
  // markers (`~openai/...`) do not change the model.
  return model.trim().toLowerCase().replace(/^~/u, "").replace(/:(?:nitro|floor|free|online|exacto)$/u, "");
}

/** Family of a model a gateway serves, by its gateway id; undefined when unknown. */
export function gatewayModelFamily(
  provider: string | undefined,
  model: string | undefined,
): ModelFamily | undefined {
  const slug = normalizeProviderMetadataIdentity(provider);
  if (slug === undefined || !MODEL_FAMILY_GATEWAYS.has(slug) || model === undefined) return undefined;
  if (slug === "abliteration") {
    // This exact build is based on DeepSeek-V4.1-Flash-1017. Other
    // abliteration ids do not establish a model family.
    return model.trim().toLowerCase() === "abliterated-model-large-flash" ? "deepseek" : undefined;
  }
  const id = modelSlug(model);
  if (id.length === 0) return undefined;
  if (slug === "openrouter") {
    const slash = id.indexOf("/");
    if (slash <= 0) return undefined;
    const author = id.slice(0, slash);
    const name = id.slice(slash + 1);
    if (author === "moonshotai" && /^kimi-(?:k[23](?:$|[-.:])|latest$)/u.test(name)) return "kimi";
    if (author === "deepseek") return "deepseek";
    if (author === "openai" && OPENAI_HOSTED_GPT.test(name) && !name.startsWith("gpt-oss")) return "openai";
    return undefined;
  }
  if (slug === "venice") {
    // Venice prefixes OpenAI's models (`openai-gpt-6-luna`, `openai-gpt-56-luna`)
    // and uses the bare DeepSeek name (`deepseek-v4-1-flash-1017`).
    if (DEEPSEEK.test(id)) return "deepseek";
    if (id.startsWith("openai-")) {
      const name = id.slice("openai-".length);
      return OPENAI_HOSTED_GPT.test(name) && !name.startsWith("gpt-oss") ? "openai" : undefined;
    }
    return undefined;
  }
  // Ollama Cloud: `deepseek-v4.1-flash:1017`, `deepseek-v4-pro:0813`. Its only
  // OpenAI models are open-weight gpt-oss builds.
  if (/^kimi-k[23](?:$|[-.:])/u.test(id)) return "kimi";
  return DEEPSEEK.test(id) ? "deepseek" : undefined;
}

/**
 * The effort a DeepSeek model reached through a gateway runs at when the
 * session sets none: high, as on DeepSeek's own API, where the route takes
 * `high`. Ollama Cloud and Venice send `none` for Off, so an unset effort
 * there is never the user's opt-out. Elsewhere (OpenRouter) a route that
 * lists `none` keeps an unset effort off the wire, since leaving it out may
 * be the opt-out. The status line, the session's effort and the wire hint all
 * read this, so they name the same level. The managed AgenC route keeps its
 * own reviewed contract.
 */
export function gatewayFamilyDefaultEffort(
  provider: string | undefined,
  model: string | undefined,
  levels: Iterable<string>,
  options: { readonly managedGateway?: boolean | undefined } = {},
): "high" | undefined {
  if (options.managedGateway === true || gatewayModelFamily(provider, model) !== "deepseek") return undefined;
  const listed = new Set(levels);
  if (!listed.has("high")) return undefined;
  const slug = normalizeProviderMetadataIdentity(provider);
  return slug === "ollama-cloud" || slug === "venice" || !listed.has("none") ? "high" : undefined;
}

/**
 * Family of the model a session talks to: the native provider's own family, or
 * the family a gateway id names.
 */
export function modelFamilyFor(
  provider: string | undefined,
  model: string | undefined,
): ModelFamily | undefined {
  const slug = normalizeProviderMetadataIdentity(provider);
  if (slug === "deepseek") return "deepseek";
  if (slug === "openai") return "openai";
  if (slug === "kimi") return "kimi";
  return gatewayModelFamily(slug, model);
}
