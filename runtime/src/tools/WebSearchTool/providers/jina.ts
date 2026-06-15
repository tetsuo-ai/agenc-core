/**
 * Jina Search API adapter.
 * GET https://s.jina.ai/?q=...
 * Auth: Authorization: Bearer <key>
 */

import type { SearchInput, SearchProvider } from './types.js'
import {
  applyDomainFilters,
  arrayField,
  isSearchProviderJsonRecord,
  normalizeHits,
  type ProviderOutput,
} from './types.js'

export const jinaProvider: SearchProvider = {
  name: 'jina',

  isConfigured() {
    return Boolean(process.env.JINA_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const url = new URL('https://s.jina.ai/')
    url.searchParams.set('q', input.query)
    url.searchParams.set('count', '10')

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${process.env.JINA_API_KEY}`,
        Accept: 'application/json',
      },
      signal,
    })

    if (!res.ok) {
      throw new Error(`Jina search error ${res.status}: ${await res.text().catch(() => '')}`)
    }

    const data: unknown = await res.json()
    const record = isSearchProviderJsonRecord(data) ? data : undefined
    const rawHits =
      record && 'data' in record
        ? arrayField(record, 'data')
        : arrayField(record, 'results')
    const hits = normalizeHits(rawHits, { inferSourceFromUrl: true })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'jina',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
