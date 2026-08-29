// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getExecutionAuthoritySettings } from './settings/settings.js'
import {
  getSubscriptionType,
  getSubscriptionTypeForContext,
  type ProviderAuthReadContext,
} from './auth.js'
import { getAPIProvider } from './model/providers.js'
import {
  getAntModelOverrideConfig,
  resolveAntModel,
} from './model/antModels.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { resolveRegisteredModelCatalogEntry } from '../llm/registry/model-catalog.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'
import { resolveSecureStorageHome } from './secureStorage/home.js'

function credentialHome() {
  return resolveSecureStorageHome()
}

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'max',
] as const satisfies readonly EffortLevel[]

export const OPENAI_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const

export type OpenAIEffortLevel = typeof OPENAI_EFFORT_LEVELS[number]
export type AvailableEffortLevel = EffortLevel | OpenAIEffortLevel
export type EffortValue = AvailableEffortLevel | number

function supportsOpenAiReasoningEffort(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized
  if (base === 'gpt-5.3-providercode-spark' || base === 'providercodespark') {
    return false
  }
  return /^gpt-5(?:[.-]|$)/.test(base)
}

function getRegisteredGrokEffortLevels(
  model: string,
): AvailableEffortLevel[] | undefined {
  const entry = resolveRegisteredModelCatalogEntry({
    provider: 'grok',
    model,
  })
  if (entry === undefined) return undefined
  return entry.supportedReasoningLevels.filter(isOpenAIEffortLevel)
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
function modelSupportsEffortForOptionalContext(
  model: string,
  context?: ProviderAuthReadContext,
): boolean {
  const m = model.toLowerCase()
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  // Grok reasoning models: the model catalog is the source of truth. Entries
  // without levels (e.g. grok-composer) correctly return false.
  if (m.startsWith('grok-')) {
    const levels = getRegisteredGrokEffortLevels(model)
    if (levels !== undefined) {
      return levels.length > 0
    }
  }
  if (
    modelUsesOpenAIEffortForOptionalContext(model, context) &&
    supportsOpenAiReasoningEffort(model)
  ) {
    return true
  }
  // Supported by a subset of AgenC 4 models
  if (
    m.includes('opus-4-6') ||
    m.includes('opus-4-7') ||
    m.includes('opus-4-8') ||
    m.includes('fable-5') ||
    m.includes('sonnet-4-6')
  ) {
    return true
  }
  // Exclude any other known compatibility models (haiku, older opus/sonnet variants)
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // Default to true for unknown model strings on 1P.
  // Do not default to true for 3P as they have different formats for their
  // model strings (ex. tetsuo-ai/agenc-core#30795)
  return getAPIProvider(context?.provider) === 'firstParty'
}

export function modelSupportsEffort(model: string): boolean {
  return modelSupportsEffortForOptionalContext(model)
}

export function modelSupportsEffortForContext(
  model: string,
  context: ProviderAuthReadContext,
): boolean {
  return modelSupportsEffortForOptionalContext(model, context)
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'max' effort.
// Per API docs, 'max' is Opus 4.6 only for public models — other models return an error.
function modelSupportsMaxEffortForOptionalContext(
  model: string,
  context?: ProviderAuthReadContext,
): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const m = model.toLowerCase()
  // Fable 5 supports the full effort range incl. 'max' (provider docs,
  // verified 2026-07-08).
  if (
    m.includes('opus-4-6') ||
    m.includes('opus-4-7') ||
    m.includes('opus-4-8') ||
    m.includes('fable-5')
  ) {
    return true
  }
  const userType =
    context === undefined
      ? process.env.USER_TYPE
      : context.environment.USER_TYPE
  if (userType === 'ant' && resolveAntModel(model)) {
    return true
  }
  return false
}

export function modelSupportsMaxEffort(model: string): boolean {
  return modelSupportsMaxEffortForOptionalContext(model)
}

export function modelSupportsMaxEffortForContext(
  model: string,
  context: ProviderAuthReadContext,
): boolean {
  return modelSupportsMaxEffortForOptionalContext(model, context)
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function isOpenAIEffortLevel(value: string): value is OpenAIEffortLevel {
  return (OPENAI_EFFORT_LEVELS as readonly string[]).includes(value)
}

export function isAvailableEffortLevel(
  value: string,
): value is AvailableEffortLevel {
  return isEffortLevel(value) || isOpenAIEffortLevel(value)
}

function modelUsesOpenAIEffortForOptionalContext(
  _model: string,
  context?: ProviderAuthReadContext,
): boolean {
  const apiProvider = getAPIProvider(context?.provider)
  return apiProvider === 'openai' || apiProvider === 'agenc'
}

export function modelUsesOpenAIEffort(model: string): boolean {
  return modelUsesOpenAIEffortForOptionalContext(model)
}

export function modelUsesOpenAIEffortForContext(
  model: string,
  context: ProviderAuthReadContext,
): boolean {
  return modelUsesOpenAIEffortForOptionalContext(model, context)
}

function getAvailableEffortLevelsForOptionalContext(
  model: string,
  context?: ProviderAuthReadContext,
): AvailableEffortLevel[] {
  const grokLevels = getRegisteredGrokEffortLevels(model)
  if (grokLevels !== undefined) {
    return grokLevels
  }
  if (!modelSupportsEffortForOptionalContext(model, context)) {
    return []
  }
  if (modelUsesOpenAIEffortForOptionalContext(model, context)) {
    return [...OPENAI_EFFORT_LEVELS] as OpenAIEffortLevel[]
  }
  const levels: EffortLevel[] = ['low', 'medium', 'high']
  if (modelSupportsMaxEffortForOptionalContext(model, context)) {
    levels.push('max')
  }
  return levels
}

export function getAvailableEffortLevels(
  model: string,
): AvailableEffortLevel[] {
  return getAvailableEffortLevelsForOptionalContext(model)
}

export function getAvailableEffortLevelsForContext(
  model: string,
  context: ProviderAuthReadContext,
): AvailableEffortLevel[] {
  return getAvailableEffortLevelsForOptionalContext(model, context)
}

export function getEffortLevelLabel(level: AvailableEffortLevel): string {
  if (level === 'xhigh') return 'Extra High'
  if (level === 'max') return 'Max'
  return capitalize(level)
}

export function openAIEffortToStandard(level: OpenAIEffortLevel): EffortLevel {
  if (level === 'xhigh') return 'max'
  return level
}

export function standardEffortToOpenAI(level: EffortLevel): OpenAIEffortLevel {
  if (level === 'max') return 'xhigh'
  return level as OpenAIEffortLevel
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isAvailableEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' can now be persisted by all users.
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  if (value === 'max') {
    return value
  }
  // Persist provider-native xhigh using the stable settings vocabulary. At
  // request time it is restored only for a model whose catalog advertises
  // xhigh; older Grok models continue to clamp max to high.
  if (value === 'xhigh') {
    return 'max'
  }
  return undefined
}

export function reasoningEffortToEffortLevel(
  value: string | undefined,
): EffortLevel | undefined {
  if (value === "none") return undefined
  if (value === "xhigh") return "max"
  return toPersistableEffort(value as EffortValue | undefined)
}

export function effortValueToReasoningEffort(
  value: EffortValue | undefined,
): "low" | "medium" | "high" | "xhigh" | undefined {
  const persistable = toPersistableEffort(value)
  return persistable === "max" ? "xhigh" : persistable
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  return reasoningEffortToEffortLevel(
    getExecutionAuthoritySettings().reasoning_effort,
  )
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model from the session-captured value, falling back to the model default.
 *
 * Environment overrides are folded into canonical config at startup; this
 * runtime path never reads mutable process-global environment state.
 */
function resolveAppliedEffortForOptionalContext(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  context?: ProviderAuthReadContext,
): EffortValue | undefined {
  const resolved =
    appStateEffortValue ??
    getDefaultEffortForModelForOptionalContext(model, context)
  if (resolved === 'max') {
    // The persisted cross-provider vocabulary calls its top tier `max`, while
    // xAI calls Grok 4.6's catalogued top tier `xhigh`.
    if (getRegisteredGrokEffortLevels(model)?.includes('xhigh')) {
      return 'xhigh'
    }
    // API rejects 'max' on non-Opus-4.6 models — downgrade to 'high'.
    if (!modelSupportsMaxEffortForOptionalContext(model, context)) {
      return 'high'
    }
  }
  return resolved
}

export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  return resolveAppliedEffortForOptionalContext(model, appStateEffortValue)
}

export function resolveAppliedEffortForContext(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  context: ProviderAuthReadContext,
): EffortValue | undefined {
  return resolveAppliedEffortForOptionalContext(
    model,
    appStateEffortValue,
    context,
  )
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): AvailableEffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

export function getDisplayedEffortLevelForContext(
  model: string,
  appStateEffort: EffortValue | undefined,
  context: ProviderAuthReadContext,
): AvailableEffortLevel {
  const resolved =
    resolveAppliedEffortForContext(model, appStateEffort, context) ?? 'high'
  return convertEffortValueToLevelForContext(resolved, context)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function getEffortSuffixForContext(
  model: string,
  effortValue: EffortValue | undefined,
  context: ProviderAuthReadContext,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffortForContext(model, effortValue, context)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevelForContext(resolved, context)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

function convertEffortValueToLevelForOptionalContext(
  value: EffortValue,
  context?: ProviderAuthReadContext,
): AvailableEffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isAvailableEffortLevel(value) ? value : 'high'
  }
  const userType =
    context === undefined
      ? process.env.USER_TYPE
      : context.environment.USER_TYPE
  if (userType === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  return 'high'
}

export function convertEffortValueToLevel(
  value: EffortValue,
): AvailableEffortLevel {
  return convertEffortValueToLevelForOptionalContext(value)
}

export function convertEffortValueToLevelForContext(
  value: EffortValue,
  context: ProviderAuthReadContext,
): AvailableEffortLevel {
  return convertEffortValueToLevelForOptionalContext(value, context)
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: AvailableEffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'max':
      return 'Maximum capability with deepest reasoning (Opus 4.6 only)'
    case 'xhigh':
      return 'Extra high reasoning effort for complex tasks on supported models'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[internal-only] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long AgenC thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
function getDefaultEffortForModelForOptionalContext(
  model: string,
  context?: ProviderAuthReadContext,
): EffortValue | undefined {
  const userType =
    context === undefined
      ? process.env.USER_TYPE
      : context.environment.USER_TYPE
  if (userType === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === config.defaultModel.toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // Always default ants to undefined/high
    return undefined
  }

  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  // Default effort on Opus 4.6/4.7/4.8 to medium for Pro.
  // Max/Team also get medium when the tengu_grey_step2 config is enabled.
  if (
    model.toLowerCase().includes('opus-4-6') ||
    model.toLowerCase().includes('opus-4-7') ||
    model.toLowerCase().includes('opus-4-8')
  ) {
    const subscriptionType =
      context === undefined
        ? getSubscriptionType(credentialHome())
        : getSubscriptionTypeForContext(context)
    if (subscriptionType === 'pro') {
      return 'medium'
    }
    if (
      getOpusDefaultEffortConfig().enabled &&
      (subscriptionType === 'max' || subscriptionType === 'team')
    ) {
      return 'medium'
    }
  }

  // When ultrathink feature is on, default effort to medium (ultrathink bumps to high)
  if (
    isUltrathinkEnabled() &&
    modelSupportsEffortForOptionalContext(model, context)
  ) {
    return 'medium'
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}

export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  return getDefaultEffortForModelForOptionalContext(model)
}

export function getDefaultEffortForModelForContext(
  model: string,
  context: ProviderAuthReadContext,
): EffortValue | undefined {
  return getDefaultEffortForModelForOptionalContext(model, context)
}
