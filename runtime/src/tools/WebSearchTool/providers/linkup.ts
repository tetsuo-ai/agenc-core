/**
 * Linkup Search API adapter.
 * POST https://api.linkup.so/v1/search
 * Auth: Authorization: Bearer <key>
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
  type ProviderOutput,
} from './types.js'

export const linkupProvider: SearchProvider = {
  name: 'linkup',

  isConfigured(environment = getSelectedProviderEnvironment()) {
    return Boolean(environment.LINKUP_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal, context?: SearchProviderContext): Promise<ProviderOutput> {
    const start = performance.now()
    const environment = context?.environment ?? getSelectedProviderEnvironment()

    const res = await fetch(context?.endpoint ?? 'https://api.linkup.so/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${environment.LINKUP_API_KEY}`,
      },
      body: JSON.stringify({
        q: input.query,
        search_type: 'standard',
        depth: 'standard',
      }),
      signal,
      redirect: 'error',
      ...getProxyFetchOptions({ environment }),
    })

    if (!res.ok) {
      throw new Error(`Linkup search error ${res.status}`)
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
