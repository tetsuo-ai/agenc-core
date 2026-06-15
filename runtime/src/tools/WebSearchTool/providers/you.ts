/**
 * You.com Search API adapter.
 * GET https://api.ydc-index.io/v1/search?query=...
 * Auth: X-API-Key: <key>
 */

import type { SearchInput, SearchProvider } from './types.js'
import {
  applyDomainFilters,
  arrayField,
  isSearchProviderJsonRecord,
  normalizeHits,
  readSearchProviderJson,
  type ProviderOutput,
} from './types.js'

export const youProvider: SearchProvider = {
  name: 'you',

  isConfigured() {
    return Boolean(process.env.YOU_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const url = new URL('https://api.ydc-index.io/v1/search')
    url.searchParams.set('query', input.query)
    url.searchParams.set('num_web_results', '10')

    const res = await fetch(url.toString(), {
      headers: { 'X-API-Key': process.env.YOU_API_KEY! },
      signal,
    })

    if (!res.ok) {
      throw new Error(`You.com search error ${res.status}: ${await res.text().catch(() => '')}`)
    }

    const data = await readSearchProviderJson(res, 'You.com search API')
    const record = isSearchProviderJsonRecord(data) ? data : undefined
    const results = record?.['results']
    const webResults = isSearchProviderJsonRecord(results)
      ? arrayField(results, 'web')
      : Array.isArray(results)
        ? results
        : []
    const hits = normalizeHits(webResults, { inferSourceFromUrl: true })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'you',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
