/**
 * Linkup Search API adapter.
 * POST https://api.linkup.so/v1/search
 * Auth: Authorization: Bearer <key>
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

export const linkupProvider: SearchProvider = {
  name: 'linkup',

  isConfigured() {
    return Boolean(process.env.LINKUP_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const res = await fetch('https://api.linkup.so/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LINKUP_API_KEY}`,
      },
      body: JSON.stringify({
        q: input.query,
        search_type: 'standard',
        depth: 'standard',
      }),
      signal,
    })

    if (!res.ok) {
      throw new Error(`Linkup search error ${res.status}: ${await res.text().catch(() => '')}`)
    }

    const data = await readSearchProviderJson(res, 'Linkup search API')
    const record = isSearchProviderJsonRecord(data) ? data : undefined
    const hits = normalizeHits(arrayField(record, 'results'), {
      inferSourceFromUrl: true,
    })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'linkup',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
