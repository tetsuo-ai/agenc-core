/**
 * Keenable Search API adapter.
 * POST https://api.keenable.ai/v1/search (KEENABLE_API_KEY set)
 * POST https://api.keenable.ai/v1/search/public (no key, explicit selection only)
 * Auth: X-API-Key: <key>, optional; the key lifts the keyless rate limit
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

export const keenableProvider: SearchProvider = {
  name: 'keenable',
  // Explicit selection runs keyless; auto mode still needs KEENABLE_API_KEY.
  selectableWithoutKey: true,

  isConfigured(environment = getSelectedProviderEnvironment()) {
    return Boolean(environment.KEENABLE_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal, context?: SearchProviderContext): Promise<ProviderOutput> {
    const start = performance.now()
    const environment = context?.environment ?? getSelectedProviderEnvironment()
    const apiKey = environment.KEENABLE_API_KEY

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Keenable-Title': 'AgenC',
    }
    if (apiKey) {
      headers['X-API-Key'] = apiKey
    }

    const body: Record<string, unknown> = {
      query: input.query,
      max_results: input.max_results ?? 10,
    }
    // Keenable filters by one site server-side; the shared filter still runs below.
    if (input.allowed_domains?.length === 1) body.site = input.allowed_domains[0]

    const res = await fetch(
      context?.endpoint ?? (apiKey ? 'https://api.keenable.ai/v1/search' : 'https://api.keenable.ai/v1/search/public'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
        ...getProxyFetchOptions({ environment }),
      },
    )

    if (!res.ok) {
      throw new Error(`Keenable search error ${res.status}`)
    }

    const data = await readSearchProviderJson(res, 'Keenable search API')
    const record = isSearchProviderJsonRecord(data) ? data : undefined
    // `description` is empty; the result text is `snippet`, raw page text with line breaks.
    const hits = normalizeHits(arrayField(record, 'results'), {
      inferSourceFromUrl: true,
    }).map(hit => hit.description
      ? { ...hit, description: hit.description.replace(/\s+/g, ' ').trim() }
      : hit)

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'keenable',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
