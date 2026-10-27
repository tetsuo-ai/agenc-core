/**
 * Prices a provider publishes with its live model list: Venice sends each
 * model's price in `model_spec.pricing` on `GET /models`, abliteration.ai in
 * `pricing` on `GET /v1/models`. Discovery records
 * them here and `resolveModelCostEntry` reads them first, so admission, the
 * session cost sidecar and the status line price a call the same way, and a
 * model only the live list has is priced at its own rate, not the registry
 * ceiling.
 *
 * @module
 */

import type { ModelCostEntry } from "../../session/cost.js";

const published = new Map<string, ReadonlyMap<string, ModelCostEntry>>();

/** Replace one provider's published prices with those of its latest list. */
export function recordPublishedModelCosts(
  provider: string,
  costs: ReadonlyMap<string, ModelCostEntry>,
): void {
  published.set(provider, costs);
}

/** The price the provider's latest list published for one of its models. */
export function publishedModelCost(
  provider: string,
  model: string,
): ModelCostEntry | undefined {
  return published.get(provider)?.get(model);
}
