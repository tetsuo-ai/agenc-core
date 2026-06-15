/**
 * Search provider adapter types.
 *
 * Every backend implements SearchProvider. WebSearchTool.selectProvider()
 * picks the right one; shared logic (domain filtering, snippet formatting,
 * result-block construction) lives in the tool layer, not in adapters.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SearchHit {
  title: string
  url: string
  description?: string
  source?: string
}

export interface SearchInput {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export interface ProviderOutput {
  hits: SearchHit[]
  /** Provider name for logging / tool_use_id */
  providerName: string
  /** Duration of the provider call in seconds */
  durationSeconds: number
}

export interface SearchProvider {
  /** Human-readable label (used in tool_use_id, logs) */
  readonly name: string
  /** Returns true when the env vars / config needed for this provider are present */
  isConfigured(): boolean
  /** Perform the search. Throw on unrecoverable errors. */
  search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput>
}

export class SearchProviderMalformedJsonError extends Error {
  constructor(source: string) {
    super(`${source} returned malformed JSON response`)
    this.name = 'SearchProviderMalformedJsonError'
  }
}

export async function readSearchProviderJson(
  response: Response,
  source: string,
): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new SearchProviderMalformedJsonError(source)
  }
}

// ---------------------------------------------------------------------------
// Flexible response parsing helpers
// ---------------------------------------------------------------------------

const TITLE_KEYS = ['title', 'headline', 'name', 'heading'] as const
const URL_KEYS = ['url', 'link', 'href', 'uri', 'permalink'] as const
const DESC_KEYS = [
  'description', 'snippet', 'content', 'preview', 'summary', 'text', 'body',
  'desc',
] as const
const SOURCE_KEYS = [
  'source', 'domain', 'displayLink', 'displayUrl', 'displayed_link', 'engine',
] as const

export type SearchProviderJsonRecord = Record<string, unknown>

export function isSearchProviderJsonRecord(
  value: unknown,
): value is SearchProviderJsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function recordField(
  obj: SearchProviderJsonRecord | null | undefined,
  key: string,
): SearchProviderJsonRecord | undefined {
  const value = obj?.[key]
  return isSearchProviderJsonRecord(value) ? value : undefined
}

export function arrayField(
  obj: SearchProviderJsonRecord | null | undefined,
  key: string,
): readonly unknown[] {
  const value = obj?.[key]
  return Array.isArray(value) ? value : []
}

function firstMatch(
  obj: SearchProviderJsonRecord,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const value = obj[k]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/** Extract a SearchHit from any object shape using well-known field aliases. */
export function normalizeHit(raw: unknown): SearchHit | null {
  if (!isSearchProviderJsonRecord(raw)) return null
  const title = firstMatch(raw, TITLE_KEYS)
  const url = firstMatch(raw, URL_KEYS)
  if (!title && !url) return null
  const hit: SearchHit = { title: title ?? url!, url: url ?? title! }
  const desc =
    firstMatch(raw, DESC_KEYS) ??
    (
      Array.isArray(raw['snippets']) &&
      typeof raw['snippets'][0] === 'string' &&
      raw['snippets'][0]
        ? raw['snippets'][0]
        : undefined
    )
  const source = firstMatch(raw, SOURCE_KEYS)
  if (desc) hit.description = desc
  if (source) hit.source = source
  return hit
}

export function normalizeHits(
  raw: unknown,
  options: { readonly inferSourceFromUrl?: boolean } = {},
): SearchHit[] {
  if (!Array.isArray(raw)) return []
  const hits: SearchHit[] = []
  for (const item of raw) {
    const hit = normalizeHit(item)
    if (!hit) continue
    if (options.inferSourceFromUrl && !hit.source) {
      const host = safeHostname(hit.url)
      if (host) hit.source = host
    }
    hits.push(hit)
  }
  return hits
}

// ---------------------------------------------------------------------------
// Domain filtering — shared across ALL providers
// ---------------------------------------------------------------------------

/** Safely extract hostname from a URL string. Returns undefined on parse failure. */
export function safeHostname(url: string | undefined): string | undefined {
  if (!url) return undefined
  try { return new URL(url).hostname } catch { return undefined }
}

/**
 * Check if a hostname exactly matches a domain or is a subdomain of it.
 * Example: hostMatchesDomain('sub.example.com', 'example.com') → true
 *          hostMatchesDomain('badexample.com', 'example.com') → false
 */
export function hostMatchesDomain(host: string, domain: string): boolean {
  if (host === domain) return true
  // Subdomain: must end with `.domain` (not just `domain`)
  return host.endsWith('.' + domain)
}

export function applyDomainFilters(
  hits: SearchHit[],
  input: SearchInput,
): SearchHit[] {
  let out = hits
  if (input.blocked_domains?.length) {
    out = out.filter(h => {
      const host = safeHostname(h.url)
      if (!host) return true // can't confirm blocked → keep
      return !input.blocked_domains!.some(d => hostMatchesDomain(host, d))
    })
  }
  if (input.allowed_domains?.length) {
    out = out.filter(h => {
      const host = safeHostname(h.url)
      if (!host) return false // can't confirm allowed → drop
      return input.allowed_domains!.some(d => hostMatchesDomain(host, d))
    })
  }
  return out
}
