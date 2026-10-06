import {
  getSelectedProviderName,
  getSelectedProviderEnvironment,
  selectedProviderIdentity,
  type ProviderRuntimeSelection,
} from './provider-selection.js'
export {
  getSelectedProviderName,
  getSelectedProviderSelection,
  getSelectedProviderModel,
  getSelectedProviderEnvironment,
  type ProviderRuntimeSelection,
} from './provider-selection.js'
import {
  registeredModelCatalogProviderIds,
  resolveRegisteredModelCatalogEntry,
} from '../../llm/registry/model-catalog.js'
import {
  snapshotProviderEnvironment,
} from '../../llm/provider-environment.js'
import {
  enterStartupProviderSelectionSnapshotForTests,
  runWithStartupProviderSelectionSnapshot,
} from './provider-selection-context.js'

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

/**
 * Bind pre-session startup work to the provider already resolved by canonical
 * startup selection. This scope is concurrency-safe and never consults the
 * daemon process environment.
 */
export function runWithStartupProviderSelection<T>(
  selection: ProviderRuntimeSelection,
  operation: () => T,
): T {
  return runWithStartupProviderSelectionSnapshot(
    freezeSelection(selection),
    operation,
  )
}

/**
 * Install the canonical provider for Vitest's current async context.
 * Production code must use `runWithStartupProviderSelection` at startup or a
 * session-owned provider service. An architecture test keeps this hook
 * confined to the test harness.
 */
export function enterStartupProviderSelectionForTestingOnly(
  selection: ProviderRuntimeSelection,
): void {
  enterStartupProviderSelectionSnapshotForTests(freezeSelection(selection))
}

function freezeSelection(
  selection: ProviderRuntimeSelection,
): ProviderRuntimeSelection {
  const model = selection.model.trim()
  if (model.length === 0) {
    throw new Error('provider authority requires a non-empty model name')
  }
  return Object.freeze({
    provider: selectedProviderIdentity(selection.provider),
    model,
    environment: snapshotProviderEnvironment(selection.environment),
  })
}

export function getAPIProvider(explicitProvider?: string): APIProvider {
  return apiProviderForProvider(getSelectedProviderName(explicitProvider))
}

export function apiProviderForProvider(provider: string): APIProvider {
  switch (selectedProviderIdentity(provider)) {
    case 'grok':
      return 'xai'
    case 'anthropic':
    case 'amazon-bedrock':
      return 'firstParty'
    case 'gemini':
      return 'gemini'
    case 'mistral':
      return 'mistral'
    case 'github':
      return 'github'
    case 'minimax':
      return 'minimax'
    case 'nvidia-nim':
      return 'nvidia-nim'
    case 'agenc':
      return 'agenc'
    case 'openai':
    case 'ollama':
    case 'lmstudio':
    case 'openai-compatible':
    case 'openrouter':
    case 'groq':
    case 'deepseek':
    case 'meta':
    default:
      return 'openai'
  }
}

export function usesAnthropicAccountFlow(provider?: string): boolean {
  return provider === undefined
    ? getAPIProvider() === 'firstParty'
    : apiProviderForProvider(provider) === 'firstParty'
}

/**
 * True when `model` is registry-owned by a built-in non-Anthropic provider
 * (grok, openai, ...). Native Anthropic identities retain their account flow.
 * This remains useful outside a bound runtime session because registry
 * ownership is determined directly from the model catalog.
 */
export function isRegistryOwnedNonAnthropicModel(model: string): boolean {
  const trimmed = model.trim()
  if (trimmed.length === 0) return false
  if (resolveRegisteredModelCatalogEntry({ provider: 'anthropic', model: trimmed }) !== undefined) {
    return false
  }
  const providers = new Set(
    registeredModelCatalogProviderIds(),
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
 * Enabled when the active session selects GitHub and the model string contains a provider-native
 * model ID (handles bare names like "claude-sonnet-4" and compound formats like
 * "github:copilot:claude-sonnet-4" or any future provider-prefixed variants).
 *
 * api.githubcopilot.com supports provider native format for AgenC models,
 * enabling prompt caching via cache_control blocks which significantly reduces
 * per-turn token costs by caching the system prompt and tool definitions.
 */
export function isGithubNativeAnthropicMode(resolvedModel: string): boolean {
  if (getAPIProvider() !== 'github') return false
  return resolvedModel.trim().toLowerCase().includes('claude-')
}
/**
 * Check if ANTHROPIC_BASE_URL is a first-party provider API URL.
 * Returns true if not set (default API) or points to api.anthropic.com.
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const environment = getSelectedProviderEnvironment()
  const baseUrl = environment.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    return host === 'api.anthropic.com'
  } catch {
    return false
  }
}

export const isFirstPartyproviderBaseUrl = isFirstPartyAnthropicBaseUrl
export const isGithubNativeproviderMode = isGithubNativeAnthropicMode
