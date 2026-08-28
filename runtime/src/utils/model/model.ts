// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them. Wrap any codename string
 * literals with process.env.USER_TYPE === 'ant' for Bun to remove the codenames
 * during dead code elimination
 */
import {
  getSubscriptionType,
  isAgenCAISubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { formatModelPricing, getOpus46CostTier } from '../modelCost.js'
import { getExecutionAuthoritySettings } from '../settings/settings.js'
import {
  getAPIProvider,
  getSelectedProviderEnvironment,
  getSelectedProviderModel,
  getSelectedProviderName,
} from './providers.js'
import type { ProviderEnvironment } from '../../llm/provider-options.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { resolveSecureStorageHome } from '../secureStorage/home.js'

function credentialHome() {
  return resolveSecureStorageHome()
}
import {
  isModelAllowed,
} from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import {
  getAntModelOverrideConfig,
  resolveAntModel,
} from './antModels.js'
import { capitalize } from '../stringUtils.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

const DEFAULT_XAI_MODEL = 'grok-4.6'

function normalizeModelSetting(value: unknown): ModelName | ModelAlias | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function getActiveProviderModel(): ModelName | undefined {
  return normalizeModelSetting(getSelectedProviderModel())
}

export function getSmallFastModel(): ModelName {
  // For Gemini provider, use a fast model
  if (getAPIProvider() === 'gemini') {
    return getActiveProviderModel() || 'gemini-2.0-flash-lite'
  }
  if (getAPIProvider() === 'mistral') {
    return getActiveProviderModel() || 'ministral-3b-latest'
  }
  // OpenAI uses the session-owned canonical model.
  if (getAPIProvider() === 'openai') {
    return getActiveProviderModel() || 'gpt-4o-mini'
  }
  // AgenC uses the session-owned canonical model.
  if (getAPIProvider() === 'agenc') {
    return getActiveProviderModel() || 'agenc'
  }
  // For GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return getActiveProviderModel() || 'github:copilot'
  }
  // NVIDIA NIM uses the session-owned canonical model.
  if (getAPIProvider() === 'nvidia-nim') {
    return getActiveProviderModel() || 'meta/llama-3.1-8b-instruct'
  }
  // MiniMax — fall back to the fastest tier (M2.5-highspeed) when missing.
  if (getAPIProvider() === 'minimax') {
    return getActiveProviderModel() || 'MiniMax-M2.5-highspeed'
  }
  // xAI uses the session-owned canonical model.
  if (getAPIProvider() === 'xai') {
    return getActiveProviderModel() || DEFAULT_XAI_MODEL
  }
  return getDefaultHaikuModel()
}

export function isNonCustomOpusModel(model: ModelName): boolean {
  return (
    model === getModelStrings().opus40 ||
    model === getModelStrings().opus41 ||
    model === getModelStrings().opus45 ||
    model === getModelStrings().opus46 ||
    model === getModelStrings().opus47 ||
    model === getModelStrings().opus48
  )
}

/**
 * Get the model from the immutable canonical startup/session selection. The
 * returned value can be a model alias.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 *
 * Priority order within this function:
 * 1. Session-owned provider/model selection
 * 2. Canonical execution settings snapshot
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  const settings = getExecutionAuthoritySettings()
  const setting = normalizeModelSetting(settings.model)
  const specifiedModel = getActiveProviderModel() || setting || undefined

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (
    specifiedModel &&
    !isModelAllowed(getSelectedProviderName(), specifiedModel, settings)
  ) {
    return undefined
  }

  return specifiedModel
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Session-owned provider/model selection
 * 2. Canonical execution settings snapshot
 * 3. Built-in default
 *
 * @returns The resolved model name to use
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

export function getBestModel(): ModelName {
  return getDefaultOpusModel()
}

// @[MODEL LAUNCH]: Update the default Opus model (3P providers may lag so keep defaults unchanged).
export function getDefaultOpusModel(): ModelName {
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return getActiveProviderModel() || 'gemini-2.5-pro'
  }
  // Mistral provider
  if (getAPIProvider() === 'mistral') {
    return getActiveProviderModel() || 'mistral-medium-latest'
  }
  // openai provider: use user-specified model or default
  if (getAPIProvider() === 'openai') {
    return getActiveProviderModel() || 'gpt-4o'
  }
  // Agenc provider: use user-specified model or default to gpt-5.5
  if (getAPIProvider() === 'agenc') {
    return getActiveProviderModel() || 'gpt-5.5'
  }
  // GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return getActiveProviderModel() || 'github:copilot'
  }
  // NVIDIA NIM
  if (getAPIProvider() === 'nvidia-nim') {
    return getActiveProviderModel() || 'nvidia/llama-3.1-nemotron-70b-instruct'
  }
  // MiniMax — flagship tier for "opus"-equivalent.
  if (getAPIProvider() === 'minimax') {
    return getActiveProviderModel() || 'MiniMax-M2.7'
  }
  // xAI — flagship Grok model for "opus"-equivalent.
  if (getAPIProvider() === 'xai') {
    return getActiveProviderModel() || DEFAULT_XAI_MODEL
  }
  // Other third-party provider API modes may lag firstParty model launches, so
  // keep their generic fallback on Opus 4.6 until they roll out 4.7.
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().opus46
  }
  return getModelStrings().opus47
}

// @[MODEL LAUNCH]: Update the default Sonnet model (3P providers may lag so keep defaults unchanged).
export function getDefaultSonnetModel(): ModelName {
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return getActiveProviderModel() || 'gemini-2.0-flash'
  }
  // Mistral provider
  if (getAPIProvider() === 'mistral') {
    return getActiveProviderModel() || 'mistral-medium-latest'
  }
  // openai provider
  if (getAPIProvider() === 'openai') {
    return getActiveProviderModel() || 'gpt-4o'
  }
  // Agenc provider
  if (getAPIProvider() === 'agenc') {
    return getActiveProviderModel() || 'gpt-5.5'
  }
  // GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return getActiveProviderModel() || 'github:copilot'
  }
  // NVIDIA NIM
  if (getAPIProvider() === 'nvidia-nim') {
    return getActiveProviderModel() || 'nvidia/llama-3.1-nemotron-70b-instruct'
  }
  // MiniMax — mid tier for "sonnet"-equivalent.
  if (getAPIProvider() === 'minimax') {
    return getActiveProviderModel() || 'MiniMax-M2.5'
  }
  // xAI — flagship Grok model for "sonnet"-equivalent.
  if (getAPIProvider() === 'xai') {
    return getActiveProviderModel() || DEFAULT_XAI_MODEL
  }
  // Default to Sonnet 4.5 for 3P since they may not have 4.6 yet
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().sonnet45
  }
  return getModelStrings().sonnet46
}

// @[MODEL LAUNCH]: Update the default Haiku model (3P providers may lag so keep defaults unchanged).
export function getDefaultHaikuModel(): ModelName {
  // Mistral provider
  if (getAPIProvider() === 'mistral') {
    return getActiveProviderModel() || 'ministral-3b-latest'
  }
  // openai provider
  if (getAPIProvider() === 'openai') {
    return getActiveProviderModel() || 'gpt-4o-mini'
  }
  // Agenc provider
  if (getAPIProvider() === 'agenc') {
    return getActiveProviderModel() || 'gpt-5.5'
  }
  // GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return getActiveProviderModel() || 'github:copilot'
  }
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return getActiveProviderModel() || 'gemini-2.0-flash-lite'
  }
  // NVIDIA NIM
  if (getAPIProvider() === 'nvidia-nim') {
    return getActiveProviderModel() || 'meta/llama-3.1-8b-instruct'
  }
  // MiniMax — fastest tier for "haiku"-equivalent.
  if (getAPIProvider() === 'minimax') {
    return getActiveProviderModel() || 'MiniMax-M2.5-highspeed'
  }
  // xAI — use the current Grok model for "haiku"-equivalent. Older fast
  // Grok aliases retired, so do not fall back to stale model IDs here.
  if (getAPIProvider() === 'xai') {
    return getActiveProviderModel() || DEFAULT_XAI_MODEL
  }

  // Haiku 4.5 is available on all platforms (first-party, Foundry, Bedrock, Vertex)
  return getModelStrings().haiku45
}

/**
 * Get the default main loop model setting.
 *
 * This handles the built-in default:
 * - Opus for Max and Team Premium users
 * - Sonnet 4.6 for all other users (including Team Standard, Pro, Enterprise)
 *
 * @returns The default model setting to use
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // GitHub Copilot provider: canonical selection, then settings, then default.
  if (getAPIProvider() === 'github') {
    const settings = getExecutionAuthoritySettings()
    return (
      getActiveProviderModel() ||
      normalizeModelSetting(settings.model) ||
      'github:copilot'
    )
  }
  // Gemini provider: always use the configured Gemini model
  if (getAPIProvider() === 'gemini') {
    return getActiveProviderModel() || 'gemini-2.0-flash'
  }
  if (getAPIProvider() === 'mistral') {
    return getActiveProviderModel() || 'mistral-medium-latest'
  }
  // OpenAI provider: canonical selection, then default.
  if (getAPIProvider() === 'openai') {
    return getActiveProviderModel() || 'gpt-4o'
  }
  // AgenC provider: canonical selection, then default (gpt-5.5).
  if (getAPIProvider() === 'agenc') {
    return getActiveProviderModel() || 'gpt-5.5'
  }
  // xAI provider: canonical selection, then current default.
  if (getAPIProvider() === 'xai') {
    return getActiveProviderModel() || DEFAULT_XAI_MODEL
  }
  if (getAPIProvider() === 'nvidia-nim') {
    return getActiveProviderModel() || 'nvidia/llama-3.1-nemotron-70b-instruct'
  }
  if (getAPIProvider() === 'minimax') {
    return getActiveProviderModel() || 'MiniMax-M2.5'
  }

  // Ants default to defaultModel from flag config, or Opus 1M if not configured
  if (getSelectedProviderEnvironment().USER_TYPE === 'ant') {
    return (
      getAntModelOverrideConfig()?.defaultModel ??
      getDefaultOpusModel() + '[1m]'
    )
  }

  // Max users get Opus as default
  if (isMaxSubscriber(credentialHome())) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium gets Opus (same as Max)
  if (isTeamPremiumSubscriber(credentialHome())) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // PAYG (1P and 3P), Enterprise, Team Standard, and Pro get Sonnet as default
  // Note that PAYG (3P) may default to an older Sonnet model
  return getDefaultSonnetModel()
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
/**
 * Pure string-match that strips date/provider suffixes from a first-party model
 * name. Input must already be a 1P-format ID (e.g. 'claude-3-7-sonnet-20250219',
 * 'us.anthropic.agenc-opus-4-6-v1:0'). Does not touch settings, so safe at
 * module top-level (see MODEL_COSTS in modelCost.ts).
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Bedrock inference-profile IDs brand the model segment as
  // "anthropic.agenc-<model>" (e.g. "us.anthropic.agenc-opus-4-6-v1"). Normalize
  // that segment back to the canonical "claude-<model>" spelling so the version
  // branches below match instead of falling through to the generic regex (which
  // would only capture "agenc-opus").
  name = name.replaceAll('anthropic.agenc-', 'anthropic.claude-')
  // Special cases for AgenC 4+ models to differentiate versions
  // Order matters: check more specific versions first (4-7 before 4-6 before 4-5 before 4)
  if (name.includes('claude-fable-5')) {
    return 'claude-fable-5'
  }
  if (name.includes('claude-opus-4-8')) {
    return 'claude-opus-4-8'
  }
  if (name.includes('claude-opus-4-7')) {
    return 'claude-opus-4-7'
  }
  if (name.includes('claude-opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (name.includes('claude-opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (/claude-opus-4-1(?![0-9])/.test(name)) {
    return 'claude-opus-4-1'
  }
  if (name.includes('claude-opus-4')) {
    return 'claude-opus-4'
  }
  if (name.includes('claude-sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (name.includes('claude-sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (name.includes('claude-sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (name.includes('claude-haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  // AgenC 3.x models use a different naming scheme for provider model IDs.
  if (name.includes('claude-3-7-sonnet')) {
    return 'claude-3-7-sonnet'
  }
  if (name.includes('claude-3-5-sonnet')) {
    return 'claude-3-5-sonnet'
  }
  if (name.includes('claude-3-5-haiku')) {
    return 'claude-3-5-haiku'
  }
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  const match = name.match(/(agenc-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // Fall back to the original name if no pattern matches
  return name
}

/**
 * Maps a full model string to a shorter canonical version that's unified across 1P and 3P providers.
 * For example, 'claude-3-5-haiku-20241022' and 'us.anthropic.agenc-3-5-haiku-20241022-v1:0'
 * would both be mapped to 'claude-3-5-haiku'.
 * @param fullModelName The full model name (e.g., 'claude-3-5-haiku-20241022')
 * @returns The short name (e.g., 'claude-3-5-haiku') if found, or the original name if no mapping exists
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Resolve overridden model IDs (e.g. Bedrock ARNs) back to canonical names.
  // resolved is always a 1P-format ID, so firstPartyNameToCanonical can handle it.
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

// @[MODEL LAUNCH]: Update the default model description strings shown to users.
export function getAgenCAiUserDefaultModelDescription(
  fastMode = false,
): string {
  if (
    isMaxSubscriber(credentialHome()) ||
    isTeamPremiumSubscriber(credentialHome())
  ) {
    if (isOpus1mMergeEnabled()) {
      return `Opus 4.7 with 1M context · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
    }
    return `Opus 4.7 · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
  }
  return 'Sonnet 4.6 · Best for everyday tasks'
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function getOpus46PricingSuffix(fastMode: boolean): string {
  if (getAPIProvider() !== 'firstParty') return ''
  const pricing = formatModelPricing(getOpus46CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

export function isOpus1mMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber(credentialHome()) ||
    getAPIProvider() !== 'firstParty'
  ) {
    return false
  }
  // Fail closed when a subscriber's subscription type is unknown. The VS Code
  // config-loading subprocess can have OAuth tokens with valid scopes but no
  // subscriptionType field (stale or partial refresh). Without this guard,
  // isProSubscriber() returns false for such users and the merge leaks
  // opus[1m] into the model dropdown — the API then rejects it with a
  // misleading "rate limit reached" error.
  if (
    isAgenCAISubscriber(credentialHome()) &&
    getSubscriptionType(credentialHome()) === null
  ) {
    return false
  }
  return true
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: Add display name cases for the new model (base + [1m] variant if applicable).
/**
 * Returns a human-readable display name for known public models, or null
 * if the model is not recognized as a public model.
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  return getPublicModelDisplayNameForProvider(model, getSelectedProviderName())
}

export function getPublicModelDisplayNameForProvider(
  model: ModelName,
  provider: string,
): string | null {
  // For openai/Gemini/Agenc/GitHub providers, show the actual model name not a AgenC alias
  if (getAPIProvider(provider) === 'openai' || getAPIProvider(provider) === 'gemini' || getAPIProvider(provider) === 'agenc' || getAPIProvider(provider) === 'github' || getAPIProvider(provider) === 'xai') {
    // Return display names for known GitHub Copilot models
    const copilotModelNames: Record<string, string> = {
      'gpt-5.5': 'GPT-5.5',
      'gpt-5.5-mini': 'GPT-5.5 mini',
      'gpt-5.4': 'GPT-5.4',
      'gpt-5.4-mini': 'GPT-5.4 mini',
      'gpt-5.3-codex': 'GPT-5.3 Agenc',
      'gpt-5.2-codex': 'GPT-5.2 Agenc',
      'gpt-5.2': 'GPT-5.2',
      'gpt-5.1-codex': 'GPT-5.1 Agenc',
      'gpt-5.1-codex-max': 'GPT-5.1 Agenc max',
      'gpt-5.1-codex-mini': 'GPT-5.1 Agenc mini',
      'gpt-4o': 'GPT-4o',
      'gpt-4.1': 'GPT-4.1',
      'claude-opus-4.6': 'AgenC Opus 4.6',
      'claude-opus-4.5': 'AgenC Opus 4.5',
      'claude-sonnet-4.6': 'AgenC Sonnet 4.6',
      'claude-sonnet-4.5': 'AgenC Sonnet 4.5',
      'claude-haiku-4.5': 'AgenC Haiku 4.5',
      'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
      'gemini-3-flash-preview': 'Gemini 3 Flash',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'grok-4.6': 'Grok 4.6',
      'grok-4.5': 'Grok 4.5',
      'grok-composer-2.5-fast': 'Grok Composer 2.5 fast',
      'grok-4.3': 'Grok 4.3',
      'grok-4.20-0309-reasoning': 'Grok 4.20 reasoning',
      'grok-4.20-0309-non-reasoning': 'Grok 4.20 non-reasoning',
      'grok-4.20-multi-agent-0309': 'Grok 4.20 multi-agent',
      'grok-code-fast-1': 'Grok Code Fast 1',
    }
    if (copilotModelNames[model]) {
      return copilotModelNames[model]
    }
    return null
  }
  switch (model) {
    case 'gpt-5.5':
      return 'GPT-5.5'
    case 'gpt-5.4':
      return 'GPT-5.4'
    case 'gpt-5.3-codex-spark':
      return 'GPT-5.3 Agenc Spark'
    case getModelStrings().fable5 + '[1m]':
      return 'Fable 5 (1M context)'
    case getModelStrings().fable5:
      return 'Fable 5'
    case getModelStrings().opus48 + '[1m]':
      return 'Opus 4.8 (1M context)'
    case getModelStrings().opus48:
      return 'Opus 4.8'
    case getModelStrings().opus47 + '[1m]':
      return 'Opus 4.7 (1M context)'
    case getModelStrings().opus47:
      return 'Opus 4.7'
    case getModelStrings().opus46 + '[1m]':
      return 'Opus 4.6 (1M context)'
    case getModelStrings().opus46:
      return 'Opus 4.6'
    case getModelStrings().opus45:
      return 'Opus 4.5'
    case getModelStrings().opus41:
      return 'Opus 4.1'
    case getModelStrings().opus40:
      return 'Opus 4'
    case getModelStrings().sonnet46 + '[1m]':
      return 'Sonnet 4.6 (1M context)'
    case getModelStrings().sonnet46:
      return 'Sonnet 4.6'
    case getModelStrings().sonnet45 + '[1m]':
      return 'Sonnet 4.5 (1M context)'
    case getModelStrings().sonnet45:
      return 'Sonnet 4.5'
    case getModelStrings().sonnet40:
      return 'Sonnet 4'
    case getModelStrings().sonnet40 + '[1m]':
      return 'Sonnet 4 (1M context)'
    case getModelStrings().sonnet37:
      return 'Sonnet 3.7'
    case getModelStrings().sonnet35:
      return 'Sonnet 3.5'
    case getModelStrings().haiku45:
      return 'Haiku 4.5'
    case getModelStrings().haiku35:
      return 'Haiku 3.5'
    default:
      return null
  }
}

function maskModelCodename(baseName: string): string {
  // Mask only the first dash-separated segment (the codename), preserve the rest
  // e.g. capybara-v2-fast → cap*****-v2-fast
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  return renderModelNameWithAuthority(
    model,
    getPublicModelDisplayName(model),
    process.env.USER_TYPE,
  )
}

export interface ModelDisplayReadContext {
  readonly provider: string
  readonly environment: ProviderEnvironment
}

export function renderModelNameForContext(
  model: ModelName,
  context: ModelDisplayReadContext,
): string {
  return renderModelNameWithAuthority(
    model,
    getPublicModelDisplayNameForProvider(model, context.provider),
    context.environment.USER_TYPE,
  )
}

function renderModelNameWithAuthority(
  model: ModelName,
  publicName: string | null,
  userType: string | undefined,
): string {
  if (publicName) {
    return publicName
  }
  // Handle GitHub Copilot special model aliases
  if (model === 'github:copilot') {
    return 'GPT-4o'
  }
  if (userType === 'ant') {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      const baseName = antModel.model.replace(/\[1m\]$/i, '')
      const masked = maskModelCodename(baseName)
      const suffix = has1mContext(resolved) ? '[1m]' : ''
      return masked + suffix
    }
    if (resolved !== model) {
      return `${model} (${resolved})`
    }
    return resolved
  }
  return model
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "AgenC {ModelName}" for publicly known models, or "AgenC ({model})"
 * for unknown/internal models so the exact model name is preserved.
 *
 * @param model The full model name
 * @returns "AgenC {ModelName}" for public models, or "AgenC ({model})" for non-public models
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `AgenC ${publicName}`
  }
  return `AgenC (${model})`
}

/**
 * Returns a full model name for use in this session, possibly after resolving
 * a model alias.
 *
 * This function intentionally does not support version numbers to align with
 * the model switcher.
 *
 * Supports [1m] suffix on any model alias (e.g., haiku[1m], sonnet[1m]) to enable
 * 1M context window without requiring each variant to be in MODEL_ALIASES.
 *
 * @param modelInput The model alias or name provided by the user.
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = normalizeModelSetting(modelInput)
  if (!modelInputTrimmed) {
    return getDefaultSonnetModel()
  }
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'sonnet':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '')
      case 'haiku':
        return getDefaultHaikuModel() + (has1mTag ? '[1m]' : '')
      case 'opus':
        return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
      case 'best':
        return getBestModel() + (has1mTag ? '[1m]' : '')
      default:
    }
  }

  if (process.env.USER_TYPE === 'ant') {
    const has1mAntTag = has1mContext(normalizedModel)
    const baseAntModel = normalizedModel.replace(/\[1m]$/i, '').trim()

    const antModel = resolveAntModel(baseAntModel)
    if (antModel) {
      const suffix = has1mAntTag ? '[1m]' : ''
      return antModel.model + suffix
    }

    // Fall through to the alias string if we cannot load the config. The API calls
    // will fail with this string, but we should hear about it through feedback and
    // can tell the user to restart/wait for flag cache refresh to get the latest values.
  }

  // Preserve original case for custom model names (e.g., Azure Foundry deployment IDs)
  // Only strip [1m] suffix if present, maintaining case of the base model
  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
  }
  return modelInputTrimmed
}

/**
 * Resolves a skill's `model:` frontmatter against the current model, carrying
 * the `[1m]` suffix over when the target family supports it.
 *
 * A skill author writing `model: opus` means "use opus-class reasoning" — not
 * "downgrade to 200K". If the user is on opus[1m] at 230K tokens and invokes a
 * skill with `model: opus`, passing the bare alias through drops the effective
 * context window from 1M to 200K, which trips autocompact at 23% apparent usage
 * and surfaces "Context limit reached" even though nothing overflowed.
 *
 * We only carry [1m] when the target actually supports it (sonnet/opus). A skill
 * with `model: haiku` on a 1M session still downgrades — haiku has no 1M variant,
 * so the autocompact that follows is correct. Skills that already specify [1m]
 * are left untouched.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M matches on canonical IDs ('claude-opus-4-6', 'claude-sonnet-4');
  // a bare 'opus' alias falls through getCanonicalName unmatched. Resolve first.
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (process.env.USER_TYPE === 'ant') {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    } else if (isAgenCAISubscriber(credentialHome())) {
      return `Default (${getAgenCAiUserDefaultModelDescription()})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: Add a marketing name mapping for the new model below.
export function getMarketingNameForModel(modelId: string): string | undefined {
  const has1m = modelId.toLowerCase().includes('[1m]')
  const canonical = getCanonicalName(modelId)

  if (canonical.includes('claude-fable-5')) {
    return has1m ? 'Fable 5 (with 1M context)' : 'Fable 5'
  }
  if (canonical.includes('claude-opus-4-8')) {
    return has1m ? 'Opus 4.8 (with 1M context)' : 'Opus 4.8'
  }
  if (canonical.includes('claude-opus-4-7')) {
    return has1m ? 'Opus 4.7 (with 1M context)' : 'Opus 4.7'
  }
  if (canonical.includes('claude-opus-4-6')) {
    return has1m ? 'Opus 4.6 (with 1M context)' : 'Opus 4.6'
  }
  if (canonical.includes('claude-opus-4-5')) {
    return 'Opus 4.5'
  }
  if (/claude-opus-4-1(?![0-9])/.test(canonical)) {
    return 'Opus 4.1'
  }
  if (canonical.includes('claude-opus-4')) {
    return 'Opus 4'
  }
  if (canonical.includes('claude-sonnet-4-6')) {
    return has1m ? 'Sonnet 4.6 (with 1M context)' : 'Sonnet 4.6'
  }
  if (canonical.includes('claude-sonnet-4-5')) {
    return has1m ? 'Sonnet 4.5 (with 1M context)' : 'Sonnet 4.5'
  }
  if (canonical.includes('claude-sonnet-4')) {
    return has1m ? 'Sonnet 4 (with 1M context)' : 'Sonnet 4'
  }
  if (canonical.includes('claude-3-7-sonnet')) {
    return 'AgenC 3.7 Sonnet'
  }
  if (canonical.includes('claude-3-5-sonnet')) {
    return 'AgenC 3.5 Sonnet'
  }
  if (canonical.includes('claude-haiku-4-5')) {
    return 'Haiku 4.5'
  }
  if (canonical.includes('claude-3-5-haiku')) {
    return 'AgenC 3.5 Haiku'
  }

  return undefined
}
