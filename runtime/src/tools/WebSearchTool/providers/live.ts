import type { ProviderEnvironment } from '../../../llm/provider-options.js'
import { customProvider } from './custom.js'
import { KEYED_SEARCH_PROVIDERS } from './keyed.js'
import { applyDomainFilters, type SearchInput, type SearchProvider, type ProviderOutput } from './types.js'

export interface LiveSearchConfig {
  readonly web_search_provider?: string
}

export interface ConfiguredSearchChain {
  readonly mode: string
  readonly providers: readonly SearchProvider[]
}

/** Never consult process.env or the legacy TUI's selected provider authority. */
export function configuredSearchChain(
  environment: ProviderEnvironment,
  config?: LiveSearchConfig,
): ConfiguredSearchChain {
  const mode = environment.WEB_SEARCH_PROVIDER?.trim() || config?.web_search_provider || 'auto'
  if (mode === 'auto') {
    return { mode, providers: KEYED_SEARCH_PROVIDERS.filter(p => p.isConfigured(environment)) }
  }
  if (mode === 'ddg' || mode === 'native') return { mode, providers: [] }
  const provider = mode === 'custom'
    ? customProvider
    : KEYED_SEARCH_PROVIDERS.find(p => p.name === mode)
  if (!provider) throw new Error('Unknown web search provider; check WEB_SEARCH_PROVIDER or tools_config.web_search_provider')
  return { mode, providers: [provider] }
}

/** Auto falls through; an explicit backend fails loudly. Caller owns DDG fallback. */
export async function runConfiguredSearchProviders(options: {
  readonly chain: ConfiguredSearchChain
  readonly environment: ProviderEnvironment
  readonly endpoint?: string
  readonly input: SearchInput
  readonly signal?: AbortSignal
}): Promise<ProviderOutput | undefined> {
  const { chain, environment, input, signal } = options
  for (const provider of chain.providers) {
    signal?.throwIfAborted()
    const providerEnvironment = provider.name === 'custom' && options.endpoint !== undefined
      ? { ...environment, WEB_SEARCH_API: options.endpoint }
      : environment
    if (!provider.isConfigured(providerEnvironment)) {
      throw new Error(`Search provider "${provider.name}" is not configured; set its API key or custom endpoint`)
    }
    try {
      const timeout = AbortSignal.timeout(30_000)
      const result = await provider.search(input, signal ? AbortSignal.any([signal, timeout]) : timeout, {
        environment: providerEnvironment,
        ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      })
      const hits = applyDomainFilters(result.hits, input).filter(hit => {
        try { return ['http:', 'https:'].includes(new URL(hit.url).protocol) } catch { return false }
      })
      if (hits.length > 0 || chain.mode !== 'auto') return { ...result, hits }
    } catch {
      signal?.throwIfAborted()
      // Provider errors can contain response bodies, proxy URLs or credentials.
      if (chain.mode !== 'auto') throw new Error(`Search provider "${provider.name}" failed`)
    }
  }
  return undefined
}
