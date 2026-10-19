/**
 * Exa Search API adapter.
 * POST https://api.exa.ai/search
 * Auth: x-api-key: <key>
 */
import type { SearchInput, SearchProvider, SearchProviderContext } from './types.js'
import { getSelectedProviderEnvironment } from '../../../utils/model/providers.js'
import { getProxyFetchOptions } from '../../../utils/proxy.js'
import {
  arrayField,
  isSearchProviderJsonRecord,
  normalizeHits,
  readSearchProviderJson,
  type ProviderOutput,
} from './types.js'

export const exaProvider: SearchProvider = {
  name: 'exa',

  isConfigured(environment = getSelectedProviderEnvironment()) {
    return Boolean(environment.EXA_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal, context?: SearchProviderContext): Promise<ProviderOutput> {
    const start = performance.now()
    const environment = context?.environment ?? getSelectedProviderEnvironment()

    const body: Record<string, unknown> = {
      query: input.query,
      numResults: input.max_results ?? 15,
      type: 'auto',
    }

    if (input.allowed_domains?.length) body.includeDomains = input.allowed_domains
    if (input.blocked_domains?.length) body.excludeDomains = input.blocked_domains

    const res = await fetch(context?.endpoint ?? 'https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': environment.EXA_API_KEY!,
      },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
      ...getProxyFetchOptions({ environment }),
    })

    if (!res.ok) {
      throw new Error(`Exa search error ${res.status}`)
    }
    const data = await readSearchProviderJson(res, 'Exa search API')
    const record = isSearchProviderJsonRecord(data) ? data : undefined
    const hits = normalizeHits(arrayField(record, 'results'), {
      inferSourceFromUrl: true,
    })
    return {
      // Exa handles domain filtering server-side via includeDomains/excludeDomains
      hits,
      providerName: 'exa',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
