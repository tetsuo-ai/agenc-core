import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { isFastModeEnabled } from './fastMode.js'
import {
  AGENC_3_5_HAIKU_CONFIG,
  AGENC_3_5_V2_SONNET_CONFIG,
  AGENC_3_7_SONNET_CONFIG,
  AGENC_HAIKU_4_5_CONFIG,
  AGENC_OPUS_4_1_CONFIG,
  AGENC_OPUS_4_5_CONFIG,
  AGENC_OPUS_4_6_CONFIG,
  AGENC_OPUS_4_7_CONFIG,
  AGENC_OPUS_4_8_CONFIG,
  AGENC_OPUS_4_CONFIG,
  AGENC_SONNET_4_5_CONFIG,
  AGENC_SONNET_4_6_CONFIG,
  AGENC_SONNET_4_CONFIG,
} from './model/configs.js'
import {
  type ModelShortName,
} from './model/model.js'

// @see https://agenc.tech/docs/en/about-agenc/pricing
export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

// Standard pricing tier for Sonnet models: $3 input / $15 output per Mtok
export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Opus 4/4.1: $15 input / $75 output per Mtok
export const COST_TIER_15_75 = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Opus 4.5: $5 input / $25 output per Mtok
export const COST_TIER_5_25 = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Fast mode pricing for Opus 4.6: $30 input / $150 output per Mtok
export const COST_TIER_30_150 = {
  inputTokens: 30,
  outputTokens: 150,
  promptCacheWriteTokens: 37.5,
  promptCacheReadTokens: 3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 3.5: $0.80 input / $4 output per Mtok
export const COST_HAIKU_35 = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 4.5: $1 input / $5 output per Mtok
export const COST_HAIKU_45 = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

const DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25

function firstPartyNameToCanonicalForCost(name: string): ModelShortName {
  const normalized = name.toLowerCase()
  if (normalized.includes('claude-opus-4-8')) return 'claude-opus-4-8'
  if (normalized.includes('claude-opus-4-7')) return 'claude-opus-4-7'
  if (normalized.includes('claude-opus-4-6')) return 'claude-opus-4-6'
  if (normalized.includes('claude-opus-4-5')) return 'claude-opus-4-5'
  if (normalized.includes('claude-opus-4-1')) return 'claude-opus-4-1'
  if (normalized.includes('claude-opus-4')) return 'claude-opus-4'
  if (normalized.includes('claude-sonnet-4-6')) return 'claude-sonnet-4-6'
  if (normalized.includes('claude-sonnet-4-5')) return 'claude-sonnet-4-5'
  if (normalized.includes('claude-sonnet-4')) return 'claude-sonnet-4'
  if (normalized.includes('claude-haiku-4-5')) return 'claude-haiku-4-5'
  if (normalized.includes('claude-3-7-sonnet')) return 'claude-3-7-sonnet'
  if (normalized.includes('claude-3-5-sonnet')) return 'claude-3-5-sonnet'
  if (normalized.includes('claude-3-5-haiku')) return 'claude-3-5-haiku'
  if (normalized.includes('claude-3-opus')) return 'claude-3-opus'
  if (normalized.includes('claude-3-sonnet')) return 'claude-3-sonnet'
  if (normalized.includes('claude-3-haiku')) return 'claude-3-haiku'
  return normalized.match(/(agenc-(\d+-\d+-)?\w+)/)?.[1] ?? normalized
}

function getCanonicalNameForCost(model: string): ModelShortName {
  return firstPartyNameToCanonicalForCost(model)
}

/**
 * Get the cost tier for Opus 4.6 based on fast mode.
 */
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_30_150
  }
  return COST_TIER_5_25
}

// @[MODEL LAUNCH]: Add a pricing entry for the new model below.
// Costs from https://agenc.tech/docs/en/about-agenc/pricing
// Web search cost: $10 per 1000 requests = $0.01 per request
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  [firstPartyNameToCanonicalForCost(AGENC_3_5_HAIKU_CONFIG.firstParty)]:
    COST_HAIKU_35,
  [firstPartyNameToCanonicalForCost(AGENC_HAIKU_4_5_CONFIG.firstParty)]:
    COST_HAIKU_45,
  [firstPartyNameToCanonicalForCost(AGENC_3_5_V2_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonicalForCost(AGENC_3_7_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonicalForCost(AGENC_SONNET_4_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonicalForCost(AGENC_SONNET_4_5_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonicalForCost(AGENC_SONNET_4_6_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonicalForCost(AGENC_OPUS_4_CONFIG.firstParty)]: COST_TIER_15_75,
  [firstPartyNameToCanonicalForCost(AGENC_OPUS_4_1_CONFIG.firstParty)]:
    COST_TIER_15_75,
  [firstPartyNameToCanonicalForCost(AGENC_OPUS_4_5_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonicalForCost(AGENC_OPUS_4_6_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonicalForCost(AGENC_OPUS_4_7_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonicalForCost(AGENC_OPUS_4_8_CONFIG.firstParty)]:
    COST_TIER_5_25,
}

/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const shortName = getCanonicalNameForCost(model)

  // Opus 4.6 / 4.7 / 4.8 share base pricing ($5/$25); all carry the fast-mode
  // premium ($30/$150). Route them through the fast-aware tier so fast usage
  // is billed correctly instead of at base.
  if (
    shortName === firstPartyNameToCanonicalForCost(AGENC_OPUS_4_6_CONFIG.firstParty) ||
    shortName === firstPartyNameToCanonicalForCost(AGENC_OPUS_4_7_CONFIG.firstParty) ||
    shortName === firstPartyNameToCanonicalForCost(AGENC_OPUS_4_8_CONFIG.firstParty)
  ) {
    const isFastMode = usage.speed === 'fast'
    return getOpus46CostTier(isFastMode)
  }

  const costs = MODEL_COSTS[shortName]
  if (!costs) {
    trackUnknownModelCost(model, shortName)
    return DEFAULT_UNKNOWN_MODEL_COST
  }
  return costs
}

function trackUnknownModelCost(_model: string, _shortName: ModelShortName): void {
  setHasUnknownModelCost()
}

// Calculate the cost of a query in US dollars.
// If the model's costs are not found, use the default model's costs.
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

function formatPrice(price: number): string {
  // Format price: integers without decimals, others with 2 decimal places
  // e.g., 3 -> "$3", 0.8 -> "$0.80", 22.5 -> "$22.50"
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  return `$${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 * e.g., "$3/$15 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalNameForCost(model)
  const costs = MODEL_COSTS[shortName]
  if (!costs) return undefined
  return formatModelPricing(costs)
}
