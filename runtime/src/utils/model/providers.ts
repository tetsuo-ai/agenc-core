import {
  REGISTERED_MODEL_CATALOG,
  resolveRegisteredModelCatalogEntry,
} from '../../llm/registry/model-catalog.js'
import { shouldUseProviderCodeTransport } from '../../services/api/providerConfig.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider =
  | 'firstParty'
  | 'openai'
  | 'gemini'
  | 'github'
  | 'agenc'
  | 'nvidia-nim'
  | 'minimax'
  | 'mistral'
  | 'xai'

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.AGENC_USE_GEMINI)
    ? 'gemini'
    :
    isEnvTruthy(process.env.AGENC_USE_MISTRAL)
    ? 'mistral'
    : isEnvTruthy(process.env.AGENC_USE_GITHUB)
      ? 'github'
      : isEnvTruthy(process.env.AGENC_USE_MINIMAX)
        ? 'minimax'
        : typeof process.env.XAI_API_KEY === 'string' && process.env.XAI_API_KEY.trim() !== ''
          ? 'xai'
          : isEnvTruthy(process.env.AGENC_USE_OPENAI)
          ? isAgenCModel()
            ? 'agenc'
            : 'openai'
          : isEnvTruthy(process.env.NVIDIA_NIM)
            ? 'nvidia-nim'
            : typeof process.env.MINIMAX_API_KEY === 'string' && process.env.MINIMAX_API_KEY.trim() !== ''
              ? 'minimax'
              : 'firstParty'
}

export function usesAnthropicAccountFlow(): boolean {
  return getAPIProvider() === 'firstParty'
}

/**
 * True when `model` is registry-owned by a built-in non-Anthropic provider
 * (grok, openai, ...; the registered catalog carries no Anthropic entries).
 * getAPIProvider() only sees env vars, so a session whose provider comes from
 * config.toml (e.g. grok via OAuth credentials, no XAI_API_KEY set) still
 * reports 'firstParty'; auth-status UI must not tell such a session it is
 * "not logged in" for lacking an Anthropic key.
 */
export function isRegistryOwnedNonAnthropicModel(model: string): boolean {
  const trimmed = model.trim()
  if (trimmed.length === 0) return false
  const providers = new Set(
    REGISTERED_MODEL_CATALOG.map(entry => entry.provider),
  )
  for (const provider of providers) {
    if (
      resolveRegisteredModelCatalogEntry({ provider, model: trimmed }) !==
      undefined
    ) {
      return true
    }
  }
  return false
}

/**
 * Returns true when the GitHub provider should use provider's native API
 * format instead of the openai-compatible shim.
 *
 * Enabled when AGENC_USE_GITHUB=1 and the model string contains a provider-native
 * model ID (handles bare names like "claude-sonnet-4" and compound formats like
 * "github:copilot:claude-sonnet-4" or any future provider-prefixed variants).
 *
 * api.githubcopilot.com supports provider native format for AgenC models,
 * enabling prompt caching via cache_control blocks which significantly reduces
 * per-turn token costs by caching the system prompt and tool definitions.
 */
export function isGithubNativeAnthropicMode(resolvedModel?: string): boolean {
  if (!isEnvTruthy(process.env.AGENC_USE_GITHUB)) return false
  const model =
    resolvedModel?.trim() ||
    process.env.GITHUB_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    ''
  return model.toLowerCase().includes('claude-')
}
function isAgenCModel(): boolean {
  const model = process.env.OPENAI_MODEL || ''
  return isAgenCShortcutAlias(model) || shouldUseProviderCodeTransport(
    model,
    process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE,
  )
}

function isAgenCShortcutAlias(model: string): boolean {
  const base = model.trim().toLowerCase().split('?', 1)[0] ?? ''
  return base === 'agencplan' || base === 'agencspark'
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party provider API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}

export const isFirstPartyproviderBaseUrl = isFirstPartyAnthropicBaseUrl
export const isGithubNativeproviderMode = isGithubNativeAnthropicMode
