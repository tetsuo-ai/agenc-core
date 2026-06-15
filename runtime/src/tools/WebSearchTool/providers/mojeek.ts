/**
 * Mojeek Search API adapter.
 * GET https://www.mojeek.com/search?q=...&fmt=json
 * Auth: optional Bearer for API tier
 */

import type { SearchInput, SearchProvider } from './types.js'
import {
  applyDomainFilters,
  arrayField,
  isSearchProviderJsonRecord,
  normalizeHits,
  readSearchProviderJson,
  recordField,
  type ProviderOutput,
} from './types.js'

export const mojeekProvider: SearchProvider = {
  name: 'mojeek',

  isConfigured() {
    return Boolean(process.env.MOJEEK_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const url = new URL('https://www.mojeek.com/search')
    url.searchParams.set('q', input.query)
    url.searchParams.set('fmt', 'json')
    url.searchParams.set('t', '10')

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    }
    if (process.env.MOJEEK_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.MOJEEK_API_KEY}`
    }

    const res = await fetch(url.toString(), { headers, signal })

    if (!res.ok) {
      throw new Error(`Mojeek search error ${res.status}: ${await res.text().catch(() => '')}`)
    }

    const data = await readSearchProviderJson(res, 'Mojeek search API')
    const record = isSearchProviderJsonRecord(data) ? data : undefined
    const rawResults =
      record && 'response' in record
        ? arrayField(recordField(record, 'response'), 'results')
        : arrayField(record, 'results')
    const hits = normalizeHits(rawResults, { inferSourceFromUrl: true })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'mojeek',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
