/**
 * Jina Search API adapter.
 * GET https://s.jina.ai/?q=...
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

export const jinaProvider: SearchProvider = {
  name: 'jina',

  isConfigured(environment = getSelectedProviderEnvironment()) {
    return Boolean(environment.JINA_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal, context?: SearchProviderContext): Promise<ProviderOutput> {
    const start = performance.now()
    const environment = context?.environment ?? getSelectedProviderEnvironment()

    const url = new URL(context?.endpoint ?? 'https://s.jina.ai/')
    url.searchParams.set('q', input.query)
    url.searchParams.set('count', String(input.max_results ?? 10))

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${environment.JINA_API_KEY}`,
        Accept: 'application/json',
      },
      signal,
      redirect: 'error',
      ...getProxyFetchOptions({ environment }),
    })

    if (!res.ok) {
      throw new Error(`Jina search error ${res.status}`)
    }

    const data = await readSearchProviderJson(res, 'Jina search API')
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
