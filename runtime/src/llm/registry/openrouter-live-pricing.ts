import type { ModelCostEntry } from "../../session/cost.js";
import type { OpenRouterCatalogRow } from "./openrouter-models.js";

function rate(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function openRouterModelIsFree(row: OpenRouterCatalogRow): boolean {
  return row.model.endsWith(":free") || (rate(row.pricing.prompt) === 0 && rate(row.pricing.completion) === 0 &&
    Object.values(row.pricing).every(value => rate(value) === 0));
}

/** Catalog estimates use per-token prices; actual response costs still take precedence. */
export function openRouterModelCosts(rows: readonly OpenRouterCatalogRow[], now = Date.now()): ReadonlyMap<string, ModelCostEntry> {
  const costs = new Map<string, ModelCostEntry>();
  for (const row of rows) {
    const date = new Date(now);
    const day = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][date.getUTCDay()];
    const clock = date.getUTCHours() * 100 + date.getUTCMinutes();
    const overrides = (row.priceOverrides ?? []).filter(override => {
      if (Array.isArray(override.utc_days) && !override.utc_days.includes(day!)) return false;
      const start = override.utc_start;
      const end = override.utc_end;
      if (typeof start !== "number" || typeof end !== "number") return true;
      return start < end ? clock >= start && clock < end : clock >= start || clock < end;
    });
    const timed = overrides.find(override => override.min_prompt_tokens === undefined);
    const pricing: OpenRouterCatalogRow["pricing"] = { ...row.pricing, ...Object.fromEntries(
      Object.entries(timed ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
    ) };
    const input = rate(pricing.prompt);
    const output = rate(pricing.completion);
    if (input === undefined || output === undefined) {
      costs.set(row.model, { inputUsdPer1K: 0, outputUsdPer1K: 0, costEstimated: true, label: "unpriced catalog model" });
      continue;
    }
    const per1k = (value: string | undefined) => {
      const parsed = rate(value);
      return parsed === undefined ? undefined : parsed * 1000;
    };
    const cachedInputUsdPer1K = per1k(pricing.input_cache_read);
    const cacheCreationUsdPer1K = per1k(pricing.input_cache_write);
    let entry: ModelCostEntry = {
      inputUsdPer1K: input * 1000,
      outputUsdPer1K: output * 1000,
      cachedInputUsdPer1K,
      cacheCreationUsdPer1K,
      cacheCreation1hUsdPer1K: per1k(pricing.input_cache_write_1h),
      reasoningOutputUsdPer1K: per1k(pricing.internal_reasoning),
      webSearchUsdPerRequest: rate(pricing.web_search),
      cachedInputIncludedInInputTokens: cachedInputUsdPer1K !== undefined,
      cacheCreationIncludedInInputTokens: cacheCreationUsdPer1K !== undefined,
      ...(input === 0 && output === 0 && Object.values(row.pricing).every(value => rate(value) === 0) && !row.priceOverrides?.length
        ? { localZeroCost: true, label: "free" }
        : { catalogEstimate: true, label: "OpenRouter catalog estimate" }),
    };
    const tiers = overrides.filter(override => typeof override.min_prompt_tokens === "number" &&
      Number.isFinite(override.min_prompt_tokens) && override.min_prompt_tokens > 0)
      .sort((left, right) => right.min_prompt_tokens! - left.min_prompt_tokens!);
    for (const tier of tiers) {
      const rates = openRouterModelCosts([{ ...row, pricing: { ...row.pricing, ...Object.fromEntries(
        Object.entries(tier).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
      ) }, priceOverrides: undefined }], now).get(row.model)!;
      entry = { ...entry, longContext: { aboveInputTokens: tier.min_prompt_tokens! - 1,
        rates: { ...rates, ...(entry.longContext === undefined ? {} : { longContext: entry.longContext }) } } };
    }
    costs.set(row.model, entry);
  }
  return costs;
}
