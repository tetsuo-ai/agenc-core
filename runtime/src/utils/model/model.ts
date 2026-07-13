// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them. Wrap any codename string
 * literals with process.env.USER_TYPE === 'ant' for Bun to remove the codenames
 * during dead code elimination
 */
import {
  getActiveConfigModel,
  getMainLoopModelOverride,
} from '../../bootstrap/state.js'
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
import { isEnvTruthy } from '../envUtils.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { formatModelPricing, getOpus46CostTier } from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getAPIProvider } from './providers.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import {
  getAntModelOverrideConfig,
  resolveAntModel,
} from './antModels.js'
import { capitalize } from '../stringUtils.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

function normalizeModelSetting(value: unknown): ModelName | ModelAlias | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

// Maps the env-driven model.ts API provider identity onto the AgenC config
// provider slug so we can match the active `config.model` selection. Only the
// providers whose session model is driven by `config.model` (rather than a
// dedicated provider env var) participate.
function configProviderSlugForApiProvider(
  provider: string,
): string | undefined {
  switch (provider) {
    case 'xai':
      return 'grok'
    case 'openai':
      return 'openai'
    case 'agenc':
      return 'agenc'
    default:
      return undefined
  }
}

// Returns the AgenC config-resolved model (`config.model`) when it was
// resolved for the active provider. This is the same value that seeds the
// daemon session's collaborationMode.model, so the env-driven helpers stay in
// sync with `agenc config set model` instead of falling back to a hardcoded
// provider default.
function getConfigModelForApiProvider(
  provider = getAPIProvider(),
): ModelName | undefined {
  const slug = configProviderSlugForApiProvider(provider)
  if (slug === undefined) return undefined
  const active = getActiveConfigModel()
  if (active === undefined || active.provider !== slug) return undefined
  return normalizeModelSetting(active.model)
}

function getActiveProviderModelEnv(provider = getAPIProvider()): ModelName | undefined {
  switch (provider) {
    case 'gemini':
      return process.env.GEMINI_MODEL
    case 'mistral':
      return process.env.MISTRAL_MODEL
    case 'github':
      return process.env.GITHUB_MODEL
    case 'nvidia-nim':
      return process.env.NVIDIA_MODEL
    case 'minimax':
      return process.env.MINIMAX_MODEL
    case 'openai':
    case 'agenc':
    case 'xai':
      // Env var (set by provider profiles) wins when present; otherwise fall
      // back to the AgenC config model so `config set model` is honored.
      return process.env.OPENAI_MODEL || getConfigModelForApiProvider(provider)
    case 'firstParty':
      return process.env.ANTHROPIC_MODEL
    default:
      return undefined
  }
}

export function getSmallFastModel(): ModelName {
  if (process.env.ANTHROPIC_SMALL_FAST_MODEL) return process.env.ANTHROPIC_SMALL_FAST_MODEL
  // For Gemini provider, use a fast model
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite'
  }
  if (getAPIProvider() === 'mistral') {
    return process.env.MISTRAL_MODEL || 'ministral-3b-latest'
  }
  // For openai provider, use OPENAI_MODEL or a sensible default
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o-mini'
  }
  // Agenc provider — OPENAI_MODEL is always set for Agenc profiles; only fall
  // back to a agenc-spark alias when an override env strips it.
  if (getAPIProvider() === 'agenc') {
    return process.env.OPENAI_MODEL || 'agencspark'
  }
  // For GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return process.env.GITHUB_MODEL || 'github:copilot'
  }
  // NVIDIA NIM — use the provider-specific model env from --provider.
  if (getAPIProvider() === 'nvidia-nim') {
    return process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct'
  }
  // MiniMax — fall back to the fastest tier (M2.5-highspeed) when missing.
  if (getAPIProvider() === 'minimax') {
    return process.env.MINIMAX_MODEL || 'MiniMax-M2.5-highspeed'
  }
  // xAI — OPENAI_MODEL carries the active Grok model.
  if (getAPIProvider() === 'xai') {
    return process.env.OPENAI_MODEL || 'grok-4.5'
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
 * Helper to get the model from /model (including via /config), the --model flag, environment variable,
 * or the saved settings. The returned value can be a model alias if that's what the user specified.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 *
 * Priority order within this function:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    const setting = normalizeModelSetting(settings.model)
    // Read the model env var that matches the active provider to prevent
    // cross-provider leaks (e.g. ANTHROPIC_MODEL sent to the openai API).
    //
    const provider = getAPIProvider()
    specifiedModel =
      getActiveProviderModelEnv(provider) ||
      setting ||
      undefined
  }

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 * 5. Built-in default
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
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.5-pro'
  }
  // Mistral provider
  if (getAPIProvider() === 'mistral') {
    return process.env.MISTRAL_MODEL || 'devstral-latest'
  }
  // openai provider: use user-specified model or default
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o'
  }
  // Agenc provider: use user-specified model or default to gpt-5.5
  if (getAPIProvider() === 'agenc') {
    return process.env.OPENAI_MODEL || 'gpt-5.5'
  }
  // GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return process.env.GITHUB_MODEL || 'github:copilot'
  }
  // NVIDIA NIM
  if (getAPIProvider() === 'nvidia-nim') {
    return process.env.NVIDIA_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'
  }
  // MiniMax — flagship tier for "opus"-equivalent.
  if (getAPIProvider() === 'minimax') {
    return process.env.MINIMAX_MODEL || 'MiniMax-M2.7'
  }
  // xAI — flagship Grok model for "opus"-equivalent.
  if (getAPIProvider() === 'xai') {
    return process.env.OPENAI_MODEL || 'grok-4.5'
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
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  }
  // Mistral provider
  if (getAPIProvider() === 'mistral') {
    return process.env.MISTRAL_MODEL || 'mistral-medium-latest'
  }
  // openai provider
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o'
  }
  // Agenc provider
  if (getAPIProvider() === 'agenc') {
    return process.env.OPENAI_MODEL || 'gpt-5.5'
  }
  // GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return process.env.GITHUB_MODEL || 'github:copilot'
  }
  // NVIDIA NIM
  if (getAPIProvider() === 'nvidia-nim') {
    return process.env.NVIDIA_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'
  }
  // MiniMax — mid tier for "sonnet"-equivalent.
  if (getAPIProvider() === 'minimax') {
    return process.env.MINIMAX_MODEL || 'MiniMax-M2.5'
  }
  // xAI — flagship Grok model for "sonnet"-equivalent.
  if (getAPIProvider() === 'xai') {
    return process.env.OPENAI_MODEL || 'grok-4.5'
  }
  // Default to Sonnet 4.5 for 3P since they may not have 4.6 yet
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().sonnet45
  }
  return getModelStrings().sonnet46
}

// @[MODEL LAUNCH]: Update the default Haiku model (3P providers may lag so keep defaults unchanged).
export function getDefaultHaikuModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }
  // Mistral provider
  if (getAPIProvider() === 'mistral') {
    return process.env.MISTRAL_MODEL || 'ministral-3b-latest'
  }
  // openai provider
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o-mini'
  }
  // Agenc provider
  if (getAPIProvider() === 'agenc') {
    return process.env.OPENAI_MODEL || 'gpt-5.5'
  }
  // GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return process.env.GITHUB_MODEL || 'github:copilot'
  }
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite'
  }
  // NVIDIA NIM
  if (getAPIProvider() === 'nvidia-nim') {
    return process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct'
  }
  // MiniMax — fastest tier for "haiku"-equivalent.
  if (getAPIProvider() === 'minimax') {
    return process.env.MINIMAX_MODEL || 'MiniMax-M2.5-highspeed'
  }
  // xAI — use the current Grok model for "haiku"-equivalent. Older fast
  // Grok aliases retired, so do not fall back to stale model IDs here.
  if (getAPIProvider() === 'xai') {
    return process.env.OPENAI_MODEL || 'grok-4.5'
  }

  // Haiku 4.5 is available on all platforms (first-party, Foundry, Bedrock, Vertex)
  return getModelStrings().haiku45
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 * @param params Subset of the runtime context to determine the model to use.
 * @returns The model to use
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // opusplan uses Opus in plan mode without [1m] suffix.
  if (
    getUserSpecifiedModelSetting() === 'opusplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getDefaultOpusModel()
  }

  // sonnetplan by default
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getDefaultSonnetModel()
  }

  return mainLoopModel
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
  // GitHub Copilot provider: check settings.model first, then env, then default
  if (getAPIProvider() === 'github') {
    const settings = getSettings_DEPRECATED() || {}
    return (
      normalizeModelSetting(process.env.GITHUB_MODEL) ||
      normalizeModelSetting(settings.model) ||
      'github:copilot'
    )
  }
  // Gemini provider: always use the configured Gemini model
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  }
  if (getAPIProvider() === 'mistral') {
    return process.env.MISTRAL_MODEL || 'devstral-latest'
  }
  // openai provider: env model, then AgenC config.model, then default
  if (getAPIProvider() === 'openai') {
    return (
      process.env.OPENAI_MODEL ||
      getConfigModelForApiProvider('openai') ||
      'gpt-4o'
    )
  }
  // Agenc provider: env model, then AgenC config.model, then default (gpt-5.5)
  if (getAPIProvider() === 'agenc') {
    return (
      process.env.OPENAI_MODEL ||
      getConfigModelForApiProvider('agenc') ||
      'gpt-5.5'
    )
  }
  // xAI provider: env model, then AgenC config.model, then default (grok-4.5)
  if (getAPIProvider() === 'xai') {
    return (
      process.env.OPENAI_MODEL ||
      getConfigModelForApiProvider('xai') ||
      'grok-4.5'
    )
  }
  if (getAPIProvider() === 'nvidia-nim') {
    return process.env.NVIDIA_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'
  }
  if (getAPIProvider() === 'minimax') {
    return process.env.MINIMAX_MODEL || 'MiniMax-M2.5'
  }

  // Ants default to defaultModel from flag config, or Opus 1M if not configured
  if (process.env.USER_TYPE === 'ant') {
    return (
      getAntModelOverrideConfig()?.defaultModel ??
      getDefaultOpusModel() + '[1m]'
    )
  }

  // Max users get Opus as default
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium gets Opus (same as Max)
  if (isTeamPremiumSubscriber()) {
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
  if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
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
  if (setting === 'opusplan') {
    return 'Opus 4.7 in plan mode, else Sonnet 4.6'
  }
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
    isProSubscriber() ||
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
  if (isAgenCAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  // Handle Agenc models - show actual model name + resolved model
  if (setting === 'agencplan') {
    return 'agencplan (gpt-5.5)'
  }
  if (setting === 'agencspark') {
    return 'agencspark (gpt-5.3-codex-spark)'
  }
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
  // For openai/Gemini/Agenc/GitHub providers, show the actual model name not a AgenC alias
  if (getAPIProvider() === 'openai' || getAPIProvider() === 'gemini' || getAPIProvider() === 'agenc' || getAPIProvider() === 'github' || getAPIProvider() === 'xai') {
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
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  // Handle GitHub Copilot special model aliases
  if (model === 'github:copilot') {
    return 'GPT-4o'
  }
  if (process.env.USER_TYPE === 'ant') {
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
      case 'opusplan':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '') // Sonnet is default, Opus in plan mode
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

  // Handle Agenc aliases - map to actual model names
  if (modelString === 'agencplan') {
    return 'gpt-5.5'
  }
  if (modelString === 'agencspark') {
    return 'gpt-5.3-codex-spark'
  }

  // Opus 4/4.1 are no longer available on the first-party API (same as
  // AgenC.ai) — silently remap to the current Opus default. The 'opus'
  // alias already resolves to 4.6, so the only users on these explicit
  // strings pinned them in settings/env/--model/SDK before 4.5 launched.
  // 3P providers may not yet have 4.6 capacity, so pass through unchanged.
  if (
    getAPIProvider() === 'firstParty' &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
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

const LEGACY_OPUS_FIRSTPARTY = [
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
]

function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRSTPARTY.includes(model)
}

/**
 * Opt-out for the compatibility Opus 4.0/4.1 → current Opus remap.
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.AGENC_DISABLE_LEGACY_MODEL_REMAP)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (process.env.USER_TYPE === 'ant') {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    } else if (isAgenCAISubscriber()) {
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

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
