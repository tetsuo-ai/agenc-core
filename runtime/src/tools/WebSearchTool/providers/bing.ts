/**
 * Bing Web Search API adapter.
 * GET https://api.bing.microsoft.com/v7.0/search?q=...
 * Auth: Ocp-Apim-Subscription-Key: <key>
 */

import type { SearchInput, SearchProvider, SearchProviderContext } from './types.js'
import { getSelectedProviderEnvironment } from '../../../utils/model/providers.js'
import { getProxyFetchOptions } from '../../../utils/proxy.js'
import {
  applyDomainFilters,
  arrayField,
  isSearchProviderJsonRecord,
  normalizeHits,
  readSearchProviderJson,
  recordField,
  type ProviderOutput,
} from './types.js'

export const bingProvider: SearchProvider = {
  name: 'bing',

  isConfigured(environment = getSelectedProviderEnvironment()) {
    return Boolean(environment.BING_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal, context?: SearchProviderContext): Promise<ProviderOutput> {
    const start = performance.now()
    const environment = context?.environment ?? getSelectedProviderEnvironment()

    const url = new URL(context?.endpoint ?? 'https://api.bing.microsoft.com/v7.0/search')
    url.searchParams.set('q', input.query)
    url.searchParams.set('count', String(input.max_results ?? 15))

    const res = await fetch(url.toString(), {
      headers: {
        'Ocp-Apim-Subscription-Key':
          environment.BING_API_KEY!,
      },
      signal,
      redirect: 'error',
      ...getProxyFetchOptions({ environment }),
    })

    if (!res.ok) {
      throw new Error(`Bing search error ${res.status}`)
    }

    const data = await readSearchProviderJson(res, 'Bing search API')
    const record = isSearchProviderJsonRecord(data) ? data : undefined
    const hits = normalizeHits(arrayField(recordField(record, 'webPages'), 'value'))

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'bing',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
