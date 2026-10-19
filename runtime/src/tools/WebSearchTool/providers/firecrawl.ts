import type { SearchInput, SearchProvider, SearchProviderContext } from './types.js'
import {
  applyDomainFilters,
  arrayField,
  isSearchProviderJsonRecord,
  normalizeHits,
  readSearchProviderJson,
  type ProviderOutput,
} from './types.js'
import { getSelectedProviderEnvironment } from '../../../utils/model/providers.js'
import { getProxyFetchOptions } from '../../../utils/proxy.js'
export const firecrawlProvider: SearchProvider = {
  name: 'firecrawl',

  isConfigured(environment = getSelectedProviderEnvironment()) {
    return Boolean(environment.FIRECRAWL_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal, context?: SearchProviderContext): Promise<ProviderOutput> {
    const start = performance.now()
    const environment = context?.environment ?? getSelectedProviderEnvironment()
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    let query = input.query
    if (input.blocked_domains?.length) {
      const exclusions = input.blocked_domains.map(d => `-site:${d}`).join(' ')
      query = `${query} ${exclusions}`
    }

    const response = await fetch(context?.endpoint ?? 'https://api.firecrawl.dev/v2/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${environment.FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, limit: input.max_results ?? 15 }),
      signal,
      redirect: 'error',
      ...getProxyFetchOptions({ environment }),
    })
    if (!response.ok) {
      throw new Error(
        `Firecrawl search error ${response.status}`,
      )
    }
    const payload = await readSearchProviderJson(response, 'Firecrawl search API')
    const root = isSearchProviderJsonRecord(payload) ? payload : undefined
    if (root?.success !== true) {
      throw new Error('Firecrawl search API returned an unsuccessful response')
    }
    const data = isSearchProviderJsonRecord(root.data) ? root.data : undefined
    const hits = applyDomainFilters(
      normalizeHits(arrayField(data, 'web')),
      input,
    )
    return {
      hits,
      providerName: 'firecrawl',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
