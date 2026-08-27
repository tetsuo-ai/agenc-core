import {
  REGISTERED_MODEL_CATALOG,
  resolveRegisteredModelCatalogEntry,
} from '../../llm/registry/model-catalog.js'
import { getCurrentRuntimeSession } from '../../session/current-session.js'
import { normalizeProviderIdentity } from '../../provider-identity.js'
import {
  snapshotProviderEnvironment,
  type ProviderEnvironment,
} from '../../llm/provider-options.js'
import {
  enterStartupProviderSelectionSnapshotForTests,
  readStartupProviderSelectionSnapshot,
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

export interface ProviderRuntimeSelection {
  readonly provider: string
  readonly model: string
  readonly environment: ProviderEnvironment
}

function selectedProviderIdentity(provider: string): string {
  const selected = normalizeProviderIdentity(provider, 'provider API projection')
  if (selected === undefined) {
    throw new Error('provider authority requires a non-empty provider name')
  }
  return selected
}

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

function sessionSelection(): ProviderRuntimeSelection | undefined {
  const session = getCurrentRuntimeSession()
  if (session === null) return undefined
  const providerService = session.services.providerService
  const binding = providerService?.current()
  if (binding === undefined || providerService === undefined) {
    throw new Error(
      'Ambient runtime session has no session-owned provider binding',
    )
  }
  return Object.freeze({
    provider: binding.provider,
    model: binding.model,
    environment: providerService.environment(),
  })
}

export function getSelectedProviderSelection(): ProviderRuntimeSelection {
  const session = sessionSelection()
  if (session !== undefined) return session
  const startupSelection = readStartupProviderSelectionSnapshot()
  if (startupSelection !== undefined) return startupSelection
  throw new Error(
    'No provider authority is bound; run inside canonical startup/session scope',
  )
}

/**
 * Project the provider selected by an explicit argument, the current session,
 * or the canonical startup scope. Provider environment is captured at ingress;
 * this compatibility projection must never read mutable process-global state.
 */
export function getSelectedProviderName(explicitProvider?: string): string {
  if (explicitProvider !== undefined) {
    return selectedProviderIdentity(explicitProvider)
  }
  return getSelectedProviderSelection().provider
}

export function getSelectedProviderModel(): string {
  return getSelectedProviderSelection().model
}

export function getSelectedProviderEnvironment(): ProviderEnvironment {
  return getSelectedProviderSelection().environment
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
 * (grok, openai, ...; the registered catalog carries no Anthropic entries).
 * This remains useful outside a bound runtime session because registry
 * ownership is determined directly from the model catalog.
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
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const environment = getSelectedProviderEnvironment()
  const baseUrl = environment.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (environment.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}

export const isFirstPartyproviderBaseUrl = isFirstPartyAnthropicBaseUrl
export const isGithubNativeproviderMode = isGithubNativeAnthropicMode
