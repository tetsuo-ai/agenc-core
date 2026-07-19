import axios, { type AxiosResponse } from 'axios'
import { LRUCache } from 'lru-cache'
import { AbortError } from '../../utils/errors.js'
import { getWebFetchUserAgent } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import {
  isBinaryContentType,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'
import { getExecutionAuthoritySettings } from '../../utils/settings/settings.js'
import type { LookupFunction } from 'node:net'
import type * as undici from 'undici'
import { ssrfGuardedLookup } from '../../utils/hooks/ssrfGuard.js'
import { isPreapprovedHost } from './preapproved.js'
// Custom error classes for domain blocking
class DomainBlockedError extends Error {
  constructor(domain: string) {
    super(`AgenC is unable to fetch from ${domain}`)
    this.name = 'DomainBlockedError'
  }
}

class DomainCheckFailedError extends Error {
  constructor(domain: string) {
    super(
      `Unable to verify if domain ${domain} is safe to fetch. This may be due to network restrictions or enterprise security policies blocking agenc.tech.`,
    )
    this.name = 'DomainCheckFailedError'
  }
}

class EgressBlockedError extends Error {
  constructor(public readonly domain: string) {
    super(
      JSON.stringify({
        error_type: 'EGRESS_BLOCKED',
        domain,
        message: `Access to ${domain} is blocked by the network egress proxy.`,
      }),
    )
    this.name = 'EgressBlockedError'
  }
}

// Cache for storing fetched URL content
type CacheEntry = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

// Cache with 15-minute TTL and 50MB size limit
// LRUCache handles automatic expiration and eviction
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB

const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
})

// Separate cache for preflight domain checks. URL_CACHE is URL-keyed, so
// fetching two paths on the same domain triggers two identical preflight
// HTTP round-trips to api.anthropic.com. This hostname-keyed cache avoids
// that. Only 'allowed' is cached — blocked/failed re-check on next attempt.
const DOMAIN_CHECK_CACHE = new LRUCache<string, true>({
  max: 128,
  ttl: 5 * 60 * 1000, // 5 minutes — shorter than URL_CACHE TTL
})

// Lazy singleton — defers the turndown → @mixmark-io/domino import (~1.4MB
// retained heap) until the first HTML fetch, and reuses one instance across
// calls (construction builds 15 rule objects; .turndown() is stateless).
// @types/turndown ships only `export =` (no .d.mts), so TS types the import
// as the class itself while Bun wraps CJS in { default } — hence the cast.
type TurndownCtor = typeof import('turndown')
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then(m => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}

// PSR requested limiting the length of URLs to 250 to lower the potential
// for a data exfiltration. However, this is too restrictive for some customers'
// legitimate use cases, such as JWT-signed URLs (e.g., cloud service signed URLs)
// that can be much longer. We already require user approval for each domain,
// which provides a primary security boundary. In addition, AgenC has
// other data exfil channels, and this one does not seem relatively high risk,
// so I'm removing that length restriction. -ab
const MAX_URL_LENGTH = 2000

// Per PSR:
// "Implement resource consumption controls because setting limits on CPU,
// memory, and network usage for the Web Fetch tool can prevent a single
// request or user from overwhelming the system."
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024

// The native-fetch fallback (used when axios+custom-lookup hangs) must keep the
// same SSRF protection as the axios path. Node's global fetch ignores axios's
// `lookup`, so we give it an undici dispatcher whose connector resolves through
// ssrfGuardedLookup — the validated IP is the one pinned to the socket, closing
// the DNS-rebinding window (a naive pre-resolve-then-fetch would re-resolve and
// reopen it). Lazy-required + memoized so undici only loads when the fallback
// actually fires. mTLS/proxy global dispatchers are intentionally not merged
// here; this edge path already did not honor per-request mTLS.
let ssrfGuardedFetchDispatcher: undici.Dispatcher | undefined
function getSsrfGuardedFetchDispatcher(): undici.Dispatcher {
  if (!ssrfGuardedFetchDispatcher) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undiciMod = require('undici') as typeof undici
    ssrfGuardedFetchDispatcher = new undiciMod.Agent({
      connect: {
        // ssrfGuardedLookup carries axios's lookup shape, which is call-
        // compatible with undici's Node-style connect lookup.
        lookup: ssrfGuardedLookup as unknown as LookupFunction,
      },
    })
  }
  return ssrfGuardedFetchDispatcher
}

/**
 * Read a fetch Response body into a Uint8Array, enforcing a hard byte cap by
 * streaming (a hostile server can omit/understate Content-Length, so the cap
 * must be enforced while reading, not from the header). Mirrors the axios
 * maxContentLength behavior on the fallback path.
 */
export async function readBodyCapped(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) {
    return new Uint8Array(0)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > MAX_HTTP_CONTENT_LENGTH) {
        await reader.cancel()
        throw new Error(
          `maxContentLength size of ${MAX_HTTP_CONTENT_LENGTH} exceeded`,
        )
      }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

// Timeout for the main HTTP fetch request (60 seconds).
// Prevents hanging indefinitely on slow/unresponsive servers.
const FETCH_TIMEOUT_MS = 60_000

// Timeout for the domain blocklist preflight check (10 seconds).
const DOMAIN_CHECK_TIMEOUT_MS = 10_000

// Cap same-host redirect hops. Without this a malicious server can return
// a redirect loop (/a → /b → /a …) and the per-request FETCH_TIMEOUT_MS
// resets on every hop, hanging the tool until user interrupt. 10 matches
// common client defaults (axios=5, follow-redirects=21, Chrome=20).
const MAX_REDIRECTS = 10

// Truncate to not spend too many tokens
export const MAX_MARKDOWN_LENGTH = 100_000

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)
  } catch {
    return false
  }
}

export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // We don't need to check protocol here, as we'll upgrade http to https when making the request

  // As long as we aren't supporting aiming to cookies or internal domains,
  // we should block URLs with usernames/passwords too, even though these
  // seem exceedingly unlikely.
  if (parsed.username || parsed.password) {
    return false
  }

  // Initial filter that this isn't a privileged, company-internal URL
  // by checking that the hostname is publicly resolvable
  const hostname = parsed.hostname
  const parts = hostname.split('.')
  if (parts.length < 2) {
    return false
  }

  return true
}

type DomainCheckResult =
  | { status: 'allowed' }
  | { status: 'blocked' }
  | { status: 'check_failed'; error: Error }

export async function checkDomainBlocklist(
  domain: string,
): Promise<DomainCheckResult> {
  // Third-party providers should not consult the first-party domain policy.
  if (getAPIProvider() !== 'firstParty') {
    return { status: 'allowed' }
  }

  if (DOMAIN_CHECK_CACHE.has(domain)) {
    return { status: 'allowed' }
  }
  try {
    const response = await axios.get(
      `https://api.anthropic.com/api/web/domain_info?domain=${encodeURIComponent(domain)}`,
      { timeout: DOMAIN_CHECK_TIMEOUT_MS },
    )
    if (response.status === 200) {
      if (response.data.can_fetch === true) {
        DOMAIN_CHECK_CACHE.set(domain, true)
        return { status: 'allowed' }
      }
      return { status: 'blocked' }
    }
    // Non-200 status but didn't throw
    return {
      status: 'check_failed',
      error: new Error(`Domain check returned status ${response.status}`),
    }
  } catch (e) {
    logError(e)
    return { status: 'check_failed', error: e as Error }
  }
}

/**
 * Check if a redirect is safe to follow
 * Allows redirects that:
 * - Add or remove "www." in the hostname
 * - Keep the origin the same but change path/query params
 * - Or both of the above
 */
export function isPermittedRedirect(
  originalUrl: string,
  redirectUrl: string,
): boolean {
  try {
    const parsedOriginal = new URL(originalUrl)
    const parsedRedirect = new URL(redirectUrl)

    if (parsedRedirect.protocol !== parsedOriginal.protocol) {
      return false
    }

    if (parsedRedirect.port !== parsedOriginal.port) {
      return false
    }

    if (parsedRedirect.username || parsedRedirect.password) {
      return false
    }

    // Now check hostname conditions
    // 1. Adding www. is allowed: example.com -> www.example.com
    // 2. Removing www. is allowed: www.example.com -> example.com
    // 3. Same host (with or without www.) is allowed: paths can change
    const stripWww = (hostname: string) => hostname.replace(/^www\./, '')
    const originalHostWithoutWww = stripWww(parsedOriginal.hostname)
    const redirectHostWithoutWww = stripWww(parsedRedirect.hostname)
    return originalHostWithoutWww === redirectHostWithoutWww
  } catch (_error) {
    return false
  }
}

/**
 * Helper function to handle fetching URLs with custom redirect handling
 * Recursively follows redirects if they pass the redirectChecker function
 *
 * Per PSR:
 * "Do not automatically follow redirects because following redirects could
 * allow for an attacker to exploit an open redirect vulnerability in a
 * trusted domain to force a user to make a request to a malicious domain
 * unknowingly"
 */
type RedirectInfo = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`)
  }

  const axiosConfig = {
    signal,
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 0,
    responseType: 'arraybuffer' as const,
    maxContentLength: MAX_HTTP_CONTENT_LENGTH,
    lookup: ssrfGuardedLookup,
    headers: {
      Accept: 'text/markdown, text/html, */*',
      'User-Agent': getWebFetchUserAgent(),
    },
  }

  try {
    return await axios.get(url, axiosConfig)
  } catch (error) {
    // Try native fetch as a fallback for timeout / network errors
    // (Bun/Node bundled contexts occasionally hang with axios + custom lookup.)
    const isTimeoutLike =
      axios.isAxiosError(error) &&
      (!error.response &&
        (error.code === 'ECONNABORTED' ||
          error.code === 'ETIMEDOUT' ||
          error.message?.toLowerCase().includes('timeout')))
    if (isTimeoutLike && !signal.aborted) {
      try {
        const fetchResponse = await fetch(url, {
          signal,
          redirect: 'manual',
          headers: axiosConfig.headers,
          // Pin connections to SSRF-validated IPs (see dispatcher comment).
          dispatcher: getSsrfGuardedFetchDispatcher(),
        } as RequestInit & { dispatcher: undici.Dispatcher })
        // Handle redirects manually
        if ([301, 302, 307, 308].includes(fetchResponse.status)) {
          const redirectLocation = fetchResponse.headers.get('location')
          if (!redirectLocation) {
            throw new Error('Redirect missing Location header')
          }
          const redirectUrl = new URL(redirectLocation, url).toString()
          if (redirectChecker(url, redirectUrl)) {
            return getWithPermittedRedirects(
              redirectUrl,
              signal,
              redirectChecker,
              depth + 1,
            )
          } else {
            return {
              type: 'redirect' as const,
              originalUrl: url,
              redirectUrl,
              statusCode: fetchResponse.status,
            }
          }
        }
        // Enforce the same 10MB cap as the axios path, streaming so a server
        // that omits/understates Content-Length cannot exhaust memory.
        const data = await readBodyCapped(fetchResponse)
        // Build an AxiosResponse-like shape so downstream code stays happy.
        // Flatten the fetch Headers into a plain object. The project's lib set
        // exposes Headers.forEach (lib.dom) but not Headers.entries (which lives
        // in lib.dom.iterable, not included here), so iterate via forEach —
        // behavior-identical to Object.fromEntries(headers.entries()).
        const headers: Record<string, string> = {}
        fetchResponse.headers.forEach((value, key) => {
          headers[key] = value
        })
        return {
          data,
          status: fetchResponse.status,
          statusText: fetchResponse.statusText,
          headers,
          config: axiosConfig,
          request: undefined,
        } as unknown as AxiosResponse<ArrayBuffer>
      } catch (fallbackError) {
        // A user abort during the fallback fetch must propagate as an abort
        // (so it's classified as an interrupt), not be swallowed and reported
        // as the original stale axios timeout.
        if (
          signal.aborted ||
          (fallbackError as { name?: string })?.name === 'AbortError' ||
          (fallbackError as { code?: string })?.code === 'ABORT_ERR'
        ) {
          throw fallbackError
        }
        // Otherwise fall through to original error handling.
      }
    }

    if (
      axios.isAxiosError(error) &&
      error.response &&
      [301, 302, 307, 308].includes(error.response.status)
    ) {
      const redirectLocation = error.response.headers.location
      if (!redirectLocation) {
        throw new Error('Redirect missing Location header')
      }

      // Resolve relative URLs against the original URL
      const redirectUrl = new URL(redirectLocation, url).toString()

      if (redirectChecker(url, redirectUrl)) {
        // Recursively follow the permitted redirect
        return getWithPermittedRedirects(
          redirectUrl,
          signal,
          redirectChecker,
          depth + 1,
        )
      } else {
        // Return redirect information to the caller
        return {
          type: 'redirect',
          originalUrl: url,
          redirectUrl,
          statusCode: error.response.status,
        }
      }
    }

    // Detect egress proxy blocks: the proxy returns 403 with
    // X-Proxy-Error: blocked-by-allowlist when egress is restricted
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      error.response.headers['x-proxy-error'] === 'blocked-by-allowlist'
    ) {
      const hostname = new URL(url).hostname
      throw new EgressBlockedError(hostname)
    }

    throw error
  }
}

function isRedirectInfo(
  response: AxiosResponse<ArrayBuffer> | RedirectInfo,
): response is RedirectInfo {
  return 'type' in response && response.type === 'redirect'
}

export type FetchedContent = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectInfo> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }

  // Check cache (LRUCache handles TTL automatically)
  const cachedEntry = URL_CACHE.get(url)
  if (cachedEntry) {
    return {
      bytes: cachedEntry.bytes,
      code: cachedEntry.code,
      codeText: cachedEntry.codeText,
      content: cachedEntry.content,
      contentType: cachedEntry.contentType,
      persistedPath: cachedEntry.persistedPath,
      persistedSize: cachedEntry.persistedSize,
    }
  }

  let parsedUrl: URL
  let upgradedUrl = url

  try {
    parsedUrl = new URL(url)

    // Upgrade http to https if needed
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:'
      upgradedUrl = parsedUrl.toString()
    }

    const hostname = parsedUrl.hostname

    // Check if the user has opted to skip the blocklist check
    // This is for enterprise customers with restrictive security policies
    // that prevent outbound connections to agenc.tech
    const settings = getExecutionAuthoritySettings()
    if (!settings.skipWebFetchPreflight) {
      const checkResult = await checkDomainBlocklist(hostname)
      switch (checkResult.status) {
        case 'allowed':
          // Continue with the fetch
          break
        case 'blocked':
          throw new DomainBlockedError(hostname)
        case 'check_failed':
          throw new DomainCheckFailedError(hostname)
      }
    }
  } catch (e) {
    if (
      e instanceof DomainBlockedError ||
      e instanceof DomainCheckFailedError
    ) {
      // Expected user-facing failures - re-throw without logging as internal error
      throw e
    }
    logError(e)
  }

  const response = await getWithPermittedRedirects(
    upgradedUrl,
    abortController.signal,
    isPermittedRedirect,
  )

  // Check if we got a redirect response
  if (isRedirectInfo(response)) {
    return response
  }

  const rawBuffer = Buffer.from(response.data)
  // Release the axios-held ArrayBuffer copy; rawBuffer owns the bytes now.
  // This lets GC reclaim up to MAX_HTTP_CONTENT_LENGTH (10MB) before Turndown
  // builds its DOM tree (which can be 3-5x the HTML size).
  ;(response as { data: unknown }).data = null
  // axios raw response header values are strings; the indexed type widens to
  // AxiosHeaderValue (string | string[] | number | boolean | AxiosHeaders),
  // but a real content-type header is always a string. Narrow to string so the
  // downstream string ops (isBinaryContentType, .includes, cache entry) typecheck.
  const contentType =
    (response.headers['content-type'] as string | undefined) ?? ''

  // Binary content: save raw bytes to disk with a proper extension so AgenC
  // can inspect the file later. We still fall through to the utf-8 decode +
  // Haiku path below — for PDFs in particular the decoded string has enough
  // ASCII structure (/Title, text streams) that Haiku can summarize it, and
  // the saved file is a supplement rather than a replacement.
  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await persistBinaryContent(rawBuffer, contentType, persistId)
    if (!('error' in result)) {
      persistedPath = result.filepath
      persistedSize = result.size
    }
  }

  const bytes = rawBuffer.length
  const htmlContent = rawBuffer.toString('utf-8')

  let markdownContent: string
  let contentBytes: number
  if (contentType.includes('text/html')) {
    markdownContent = (await getTurndownService()).turndown(htmlContent)
    contentBytes = Buffer.byteLength(markdownContent)
  } else {
    // It's not HTML - just use it raw. The decoded string's UTF-8 byte
    // length equals rawBuffer.length (modulo U+FFFD replacement on invalid
    // bytes — negligible for cache eviction accounting), so skip the O(n)
    // Buffer.byteLength scan.
    markdownContent = htmlContent
    contentBytes = bytes
  }

  // Store the fetched content in cache. Note that it's stored under
  // the original URL, not the upgraded or redirected URL.
  const entry: CacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
    persistedPath,
    persistedSize,
  }
  // lru-cache requires positive integers; clamp to 1 for empty responses.
  URL_CACHE.set(url, entry, { size: Math.max(1, contentBytes) })
  return entry
}

function buildFallbackMarkdownSummary(truncatedContent: string): string {
  return [
    '[ADMISSION_DENIED: legacy_web_fetch_secondary_model_path_disabled.',
    'Returning bounded raw fetched content without a secondary model call.]',
    '',
    truncatedContent,
  ].join('\n')
}

export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  isPreapprovedDomain: boolean,
): Promise<string> {
  void prompt
  void isNonInteractiveSession
  void isPreapprovedDomain

  if (signal.aborted) {
    throw new AbortError()
  }

  // The legacy secondary-model shortcut was outside execution admission.
  // Keep WebFetch useful and deterministic while failing that model path
  // closed: return only bounded content that has already been fetched.
  const truncatedContent =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) +
        '\n\n[Content truncated due to length...]'
      : markdownContent

  return buildFallbackMarkdownSummary(truncatedContent)
}
