// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { resolveAntModel } from './model/antModels.js'
import { getModelCapability } from './model/modelCapabilities.js'
import { getOpenAIContextWindow, getOpenAIMaxOutputTokens } from './model/openaiContextWindows.js'
import { resolveModelCatalogMetadata } from '../llm/registry/model-catalog.js'

// Model context window size (200k tokens for all models right now)
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Fallback context window for unknown 3P models. Must be large enough that
// the effective context (this minus output token reservation) stays positive,
// otherwise auto-compact fires on every message (issue #635).
// Override via AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW env var to avoid
// hardcoding when deploying models not yet in openaiContextWindows.ts.
export const OPENAI_FALLBACK_CONTEXT_WINDOW = (() => {
  const v = parseInt(process.env.AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW ?? '', 10)
  return !isNaN(v) && v > 0 ? v : 128_000
})()

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// agenc.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.AGENC_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

/**
 * Parse the numeric version of a Claude family model out of a canonical
 * model id. `claude-opus-4-6` -> 4.06, `claude-opus-4-10` -> 4.10,
 * `claude-sonnet-5` -> 5. Returns undefined when the string does not
 * name that family. Version-threshold comparisons replace per-release
 * string allowlists so a new minor release (e.g. a hypothetical
 * opus-4-9) inherits family capabilities instead of silently regressing
 * — the Opus 4.7 half-onboarding failure mode.
 */
export function claudeFamilyVersion(
  model: string,
  family: 'opus' | 'sonnet' | 'haiku' | 'fable',
): number | undefined {
  // Minor is capped at 2 digits with a no-digit lookahead so dated ids
  // ('claude-opus-4-20250514' = Opus 4.0) don't parse the date as a minor.
  const match = model
    .toLowerCase()
    .match(
      new RegExp(`(?:claude|agenc)-${family}-(\\d+)(?:[.-](\\d{1,2})(?!\\d))?`),
    )
  if (!match) return undefined
  const major = parseInt(match[1]!, 10)
  const minor = match[2] !== undefined ? parseInt(match[2], 10) : 0
  return major + minor / 100
}

// @[MODEL LAUNCH]: 1M support is threshold-based (opus >= 4.6, sonnet >= 4);
// new minor releases inherit automatically. Only touch this for a NEW family
// or a capability regression.
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Parse the RAW model string first: getCanonicalName collapses minors
  // it doesn't know yet ('claude-opus-4-9' -> 'claude-opus-4'), which
  // would defeat the future-release threshold. Canonical is the fallback
  // for aliases/provider spellings the regex can't see.
  const canonical = getCanonicalName(model)
  for (const candidate of [model, canonical]) {
    // Fable 5+: 1M context is the default (and maximum) window per the
    // provider docs (verified 2026-07-08).
    const fableVersion = claudeFamilyVersion(candidate, 'fable')
    if (fableVersion !== undefined) {
      return fableVersion >= 5
    }
    const opusVersion = claudeFamilyVersion(candidate, 'opus')
    if (opusVersion !== undefined) {
      return opusVersion >= 4.06
    }
    const sonnetVersion = claudeFamilyVersion(candidate, 'sonnet')
    if (sonnetVersion !== undefined) {
      return sonnetVersion >= 4
    }
  }
  return false
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Allow override via environment variable (internal-only)
  // This takes precedence over all other context window resolution, including 1M detection,
  // so users can cap the effective context window for local decisions (auto-compact, etc.)
  // while still using a 1M-capable endpoint.
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.AGENC_MAX_CONTEXT_TOKENS
  ) {
    const override = parseInt(process.env.AGENC_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mContext(model)) {
    return 1_000_000
  }

  // Registry first: REGISTERED_MODEL_CATALOG is the single source of truth for
  // model context windows. When the model resolves to a catalog entry (e.g.
  // grok-* and registered openai models), use that value so the TUI resolver
  // agrees with the grok adapter path (kills the 2M-vs-1M grok-4.3 mismatch).
  const catalogContextWindow = resolveCatalogContextWindow(model)
  if (catalogContextWindow !== undefined) {
    return catalogContextWindow
  }

  // openai-compatible provider — use known context windows for the model.
  // Unknown models get a conservative 128k default. This was previously 8k,
  // but that caused auto-compact to fire on every turn because the effective
  // context (8k minus output reservation) became negative (issue #635).
  const isOpenAIProvider =
    isEnvTruthy(process.env.AGENC_USE_OPENAI) ||
    isEnvTruthy(process.env.AGENC_USE_GEMINI) ||
    isEnvTruthy(process.env.AGENC_USE_GITHUB) ||
    isEnvTruthy(process.env.AGENC_USE_MISTRAL)
  if (isOpenAIProvider) {
    const openaiWindow = getOpenAIContextWindow(model)
    if (openaiWindow !== undefined) {
      return openaiWindow
    }
    console.error(
      `[context] Warning: model "${model}" not in context window table — using conservative 128k default. ` +
      'Add it to src/utils/model/openaiContextWindows.ts for accurate compaction.',
    )
    return OPENAI_FALLBACK_CONTEXT_WINDOW
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return antModel.contextWindow
    }
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

/**
 * Resolves a model's context window from REGISTERED_MODEL_CATALOG when the
 * model is registered. Scoped to grok-* model strings: this is the family the
 * registry migration covers, and limiting the lookup keeps openai/anthropic
 * TUI resolution behavior unchanged for models still resolved elsewhere.
 */
function resolveCatalogContextWindow(model: string): number | undefined {
  const normalized = model.trim().toLowerCase()
  if (!normalized.startsWith('grok-')) {
    return undefined
  }
  return resolveModelCatalogMetadata({ provider: 'grok', model })?.contextWindow
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  // openai-compatible provider — use known output limits to avoid 400 errors
  if (
    isEnvTruthy(process.env.AGENC_USE_OPENAI) ||
    isEnvTruthy(process.env.AGENC_USE_GEMINI) ||
    isEnvTruthy(process.env.AGENC_USE_GITHUB) ||
    isEnvTruthy(process.env.AGENC_USE_MISTRAL)
  ) {
    const openaiMax = getOpenAIMaxOutputTokens(model)
    if (openaiMax !== undefined) {
      return { default: openaiMax, upperLimit: openaiMax }
    }
  }

  const m = getCanonicalName(model)

  // Raw-first for the same reason as modelSupports1M: canonicalization
  // collapses not-yet-known minors down to 'claude-opus-4'.
  const fableVersion =
    claudeFamilyVersion(model, 'fable') ?? claudeFamilyVersion(m, 'fable')
  const opusVersion =
    claudeFamilyVersion(model, 'opus') ?? claudeFamilyVersion(m, 'opus')
  if (fableVersion !== undefined && fableVersion >= 5) {
    // Fable 5+: 128K max output (provider docs, verified 2026-07-08).
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (opusVersion !== undefined && opusVersion >= 4.06) {
    // Opus 4.6+ (incl. 4.7/4.8): 128K max output. 4.7 previously fell
    // through to the generic opus-4 32K branch.
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
