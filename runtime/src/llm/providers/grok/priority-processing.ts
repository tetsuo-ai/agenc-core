/**
 * xAI priority processing: `service_tier: "priority"` on a Chat Completions
 * or Responses request asks for higher scheduling priority, which xAI says
 * typically lowers time-to-first-token and inter-token latency under load.
 * It bills at 2x the standard rate of every token type (input, cached input,
 * output, reasoning), with the prompt-cache discount applied first, and only
 * when the response's `service_tier` reports "priority"; a request served at
 * the default tier reports "default" and bills standard. It is not the
 * "Grok 4.7 Fast" model, which xAI serves only in Cursor and Grok Build.
 * Sources, read 2026-09-24:
 * https://docs.x.ai/developers/advanced-api-usage/priority-processing
 * https://docs.x.ai/developers/pricing (Priority Processing Pricing)
 *
 * The session's `service_tier = "priority"` is AgenC's one "Fast" dial. The
 * Grok catalog rows that list a Fast tier (`additionalSpeedTiers`) are the
 * models it is sent for: Grok 4.7, the model xAI's priority examples use,
 * and Grok 4.6, which has the same prices. xAI publishes no per-model list.
 * Its documentation covers API-key requests and says nothing about the Sign
 * in with X grant (whether it can use priority processing, or how it would
 * be billed), so a provider on that route never sends it and a session bound
 * to it does not list the tier.
 */
import { resolveRegisteredModelCatalogEntry } from "../../registry/model-catalog.js";
import type { ModelInfo } from "../../../session/turn-context.js";

/** The request and response value for the priority tier. */
export const XAI_PRIORITY_SERVICE_TIER = "priority";

/** True when the Grok catalog row for `model` lists a Fast tier. */
export function xaiSupportsPriorityProcessing(
  model: string | undefined,
): boolean {
  const entry = resolveRegisteredModelCatalogEntry({ provider: "grok", model });
  return entry?.additionalSpeedTiers.some(
    (tier) => tier === "fast" || tier === "priority",
  ) === true;
}

/**
 * Whether a request carries `service_tier: "priority"`: the turn asked for
 * the priority tier, the model has a Fast tier, and the bearer is not the
 * xAI sign-in grant (`authMode: "oauth"`).
 */
export function xaiSendsPriorityProcessing(params: {
  readonly model: string | undefined;
  readonly serviceTier: string | undefined;
  readonly authMode: unknown;
}): boolean {
  return (
    params.serviceTier === XAI_PRIORITY_SERVICE_TIER &&
    params.authMode !== "oauth" &&
    xaiSupportsPriorityProcessing(params.model)
  );
}

/**
 * The speed xAI reports it served a request at. The response's
 * `service_tier` is "priority" when priority processing was applied and
 * "default" otherwise; xAI's API reference also lists "fast", which it
 * treats as the same tier.
 */
export function xaiServedSpeed(serviceTier: unknown): "fast" | undefined {
  return serviceTier === XAI_PRIORITY_SERVICE_TIER || serviceTier === "fast"
    ? "fast"
    : undefined;
}

/**
 * The model info for a session bound to `binding`. A Grok provider on the
 * xAI sign-in route never sends priority processing, so it does not list
 * the Fast tier the catalog gives the model; any other binding keeps the
 * model info as it is.
 */
export function withoutXaiSignInFastTier(
  modelInfo: ModelInfo,
  binding: {
    readonly provider: string;
    readonly factoryOptions: {
      readonly extra?: Readonly<Record<string, unknown>>;
    };
  },
): ModelInfo {
  if (
    binding.provider !== "grok" ||
    binding.factoryOptions.extra?.authMode !== "oauth" ||
    modelInfo.serviceTiers === undefined
  ) {
    return modelInfo;
  }
  const { serviceTiers, ...rest } = modelInfo;
  const kept = serviceTiers.filter(
    (tier) => tier.id !== XAI_PRIORITY_SERVICE_TIER,
  );
  return kept.length > 0 ? { ...rest, serviceTiers: kept } : rest;
}
