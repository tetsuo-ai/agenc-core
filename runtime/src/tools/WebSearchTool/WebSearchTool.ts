import { getAPIProvider } from 'src/utils/model/providers.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { resolveProviderRequest } from '../../services/api/providerConfig.js'
import { buildTool, type ToolDef } from '../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import { AdmissionDeniedError } from '../../budget/admission-client.js'

import {
  runSearch,
  getProviderMode,
  getAvailableProviders,
  type ProviderOutput,
} from './providers/index.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().min(2).describe('The search query to use'),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe('Only include search results from these domains'),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe('Never include search results from these domains'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const searchResultSchema = lazySchema(() => {
  const searchHitSchema = z.object({
    title: z.string().describe('The title of the search result'),
    url: z.string().describe('The URL of the search result'),
  })

  return z.object({
    tool_use_id: z.string().describe('ID of the tool use'),
    content: z.array(searchHitSchema).describe('Array of search hits'),
  })
})

export type SearchResult = z.infer<ReturnType<typeof searchResultSchema>>

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string().describe('The search query that was executed'),
    results: z
      .array(z.union([searchResultSchema(), z.string()]))
      .describe('Search results and/or text commentary from the model'),
    durationSeconds: z.number().describe('Time taken to complete the search operation'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// Re-export WebSearchProgress from centralized types to break import cycles
export type { WebSearchProgress } from '../../types/tools.js'

import type { WebSearchProgress } from '../../types/tools.js'

// ---------------------------------------------------------------------------
// Shared formatting: ProviderOutput → Output
// ---------------------------------------------------------------------------

function formatProviderOutput(po: ProviderOutput, query: string): Output {
  const results: (SearchResult | string)[] = []

  const snippets = po.hits
    .filter(h => h.description)
    .map(h => `**${h.title}** — ${h.description} (${h.url})`)
    .join('\n')
  if (snippets) results.push(snippets)

  if (po.hits.length > 0) {
    results.push({
      tool_use_id: `${po.providerName}-search`,
      content: po.hits.map(h => ({ title: h.title, url: h.url })),
    })
  }

  if (results.length === 0) results.push('No results found.')

  return {
    query,
    results,
    durationSeconds: po.durationSeconds,
  }
}

// ---------------------------------------------------------------------------
// Legacy provider detection and response parsing. Direct model-backed search
// execution is disabled below until it can use the session admission boundary.
// ---------------------------------------------------------------------------

function isProviderCodeResponsesWebSearchEnabled(): boolean {
  if (getAPIProvider() !== 'openai') {
    return false
  }

  const request = resolveProviderRequest({
    model: getMainLoopModel(),
    baseUrl: process.env.OPENAI_BASE_URL,
  })
  return request.transport === 'providerCode_responses'
}

function pushProviderCodeTextResult(results: (SearchResult | string)[], value: unknown): void {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (trimmed) {
    results.push(trimmed)
  }
}

function addProviderCodeSource(
  sourceMap: Map<string, { title: string; url: string }>,
  source: unknown,
): void {
  const src = asProviderCodeRecord(source)
  if (typeof src?.url !== 'string' || !src.url) return
  sourceMap.set(src.url, {
    title: typeof src.title === 'string' && src.title ? src.title : src.url,
    url: src.url,
  })
}

function asProviderCodeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function providerCodeArrayField(
  item: Record<string, unknown> | undefined,
  field: string,
): unknown[] {
  const value = item?.[field]
  return Array.isArray(value) ? value : []
}

function providerCodeMessage(value: unknown): string | undefined {
  const record = asProviderCodeRecord(value)
  const message = record?.message
  return typeof message === 'string' && message ? message : undefined
}

function getProviderCodeSources(item: Record<string, unknown>): unknown[] {
  const action = asProviderCodeRecord(item.action)
  const actionSources = providerCodeArrayField(action, 'sources')
  if (actionSources.length > 0) {
    return actionSources
  }
  const sources = providerCodeArrayField(item, 'sources')
  if (sources.length > 0) {
    return sources
  }
  const resultSources = providerCodeArrayField(asProviderCodeRecord(item.result), 'sources')
  if (resultSources.length > 0) {
    return resultSources
  }
  return []
}

function extractProviderCodeWebSearchFailure(item: Record<string, unknown>): string | undefined {
  // ProviderCode web_search_call items can carry a status field. When the tool
  // call fails (rate limit, upstream error, model-side guardrail), the
  // parser should surface a meaningful error rather than the generic
  // "No results found." fallback. Shape observed across recent payloads:
  //   { type: 'web_search_call', status: 'failed', error: { message?: string } }
  //   { type: 'web_search_call', status: 'failed', action: { error?: { message?: string } } }
  if (item.status !== 'failed') return undefined
  const action = asProviderCodeRecord(item.action)
  const reason =
    providerCodeMessage(item.error) ||
    providerCodeMessage(action?.error) ||
    (typeof item.error === 'string' && item.error) ||
    undefined
  return reason ? `Web search failed: ${reason}` : 'Web search failed.'
}

function makeOutputFromProviderCodeWebSearchResponse(
  response: Record<string, unknown>,
  query: string,
  durationSeconds: number,
): Output {
  const results: (SearchResult | string)[] = []
  const sourceMap = new Map<string, { title: string; url: string }>()
  const output = Array.isArray(response.output) ? response.output : []

  for (const rawItem of output) {
    const item = asProviderCodeRecord(rawItem)
    if (!item) continue
    if (item?.type === 'web_search_call') {
      const failure = extractProviderCodeWebSearchFailure(item)
      if (failure) {
        results.push(failure)
      }
      for (const source of getProviderCodeSources(item)) {
        addProviderCodeSource(sourceMap, source)
      }
      continue
    }

    const content = providerCodeArrayField(item, 'content')
    if (item.type !== 'message' || content.length === 0) {
      continue
    }

    for (const rawPart of content) {
      const part = asProviderCodeRecord(rawPart)
      if (!part) continue
      if (part?.type === 'output_text' || part?.type === 'text') {
        pushProviderCodeTextResult(results, part.text)
      }

      for (const source of getProviderCodeSources(part)) {
        addProviderCodeSource(sourceMap, source)
      }

      for (const rawAnnotation of providerCodeArrayField(part, 'annotations')) {
        const annotation = asProviderCodeRecord(rawAnnotation)
        if (annotation?.type !== 'url_citation') continue
        addProviderCodeSource(sourceMap, annotation)
      }
    }
  }

  if (results.length === 0) {
    pushProviderCodeTextResult(results, response.output_text)
  }

  if (sourceMap.size > 0) {
    results.push({
      tool_use_id: 'providerCode-web-search',
      content: Array.from(sourceMap.values()),
    })
  }

  if (results.length === 0) {
    results.push('No results found.')
  }

  return {
    query,
    results,
    durationSeconds,
  }
}

export const __test = {
  makeOutputFromProviderCodeWebSearchResponse,
}

// ---------------------------------------------------------------------------
// Helper: should we use adapter-based providers?
// ---------------------------------------------------------------------------

/**
 * Returns true for transient errors that are safe to fall through on in auto mode
 * (network failures, timeouts, HTTP 5xx). Config and guardrail errors return false.
 */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return true
  const msg = err.message.toLowerCase()
  // Guardrail / config errors — must surface
  if (msg.includes('must use https')) return false
  if (msg.includes('private/reserved address')) return false
  if (msg.includes('not in the safe allowlist')) return false
  if (msg.includes('exceeds') && msg.includes('bytes')) return false
  if (msg.includes('not a valid url')) return false
  if (msg.includes('is not configured')) return false
  // Transient errors — safe to fall through
  if (err.name === 'AbortError') return true
  if (msg.includes('timed out')) return true
  if (msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('enotfound'))
    return true
  if (msg.includes('returned 5')) return true // HTTP 5xx
  // Unknown — treat as transient to preserve auto-mode fallback semantics
  return true
}

/**
 * Returns true when we should use the adapter-based provider system.
 *
 * In auto mode: native/first-party/ProviderCode paths take precedence.
 *   → Only falls back to adapter if no native path is available.
 * In explicit adapter modes (tavily, ddg, custom, etc.): always true.
 * In native mode: never true.
 */
function shouldUseAdapterProvider(): boolean {
  const mode = getProviderMode()
  if (mode === 'native') return false
  if (mode !== 'auto') return true // explicit adapter mode (tavily, ddg, custom, etc.)

  // Auto mode: native/first-party/ProviderCode take precedence over adapter
  if (isProviderCodeResponsesWebSearchEnabled()) return false
  // Widened to string: 'vertex'/'foundry' are not in the APIProvider union
  // (latent bug — see notedBugs), so these comparisons are always false today.
  const provider: string = getAPIProvider()
  if (provider === 'firstParty' || provider === 'vertex' || provider === 'foundry') {
    return false
  }
  // No native path available — fall back to adapter
  return getAvailableProviders().length > 0
}

/**
 * Returns true when the current provider has a working native or ProviderCode
 * web-search fallback after an adapter failure. OpenAi shim providers
 * (moonshot, minimax, nvidia-nim, openai, github, etc.) do NOT support
 * provider's web_search_20250305 tool, so falling through to the native
 * path silently produces "Did 0 searches".
 */
function hasNativeSearchFallback(): boolean {
  if (isProviderCodeResponsesWebSearchEnabled()) return true
  // Widened to string: 'vertex'/'foundry' are not in the APIProvider union
  // (latent bug — see notedBugs), so those comparisons are always false today.
  const provider: string = getAPIProvider()
  return provider === 'firstParty' || provider === 'vertex' || provider === 'foundry'
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

export const WebSearchTool = buildTool({
  name: WEB_SEARCH_TOOL_NAME,
  searchHint: 'search the web for current information',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    return `AgenC wants to search the web for: ${input.query}`
  },
  userFacingName() {
    return 'Web Search'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching the web'
  },
  isEnabled() {
    const mode = getProviderMode()

    // Specific provider mode: enabled if any adapter is configured
    if (mode !== 'auto' && mode !== 'native') {
      return getAvailableProviders().length > 0
    }

    // Auto/native mode: check all paths
    if (getAvailableProviders().length > 0) return true
    if (isProviderCodeResponsesWebSearchEnabled()) return true

    // Widened to string: 'vertex'/'foundry' are not in the APIProvider union
    // (latent bug — see notedBugs), so those branches are dead today.
    const provider: string = getAPIProvider()
    const model = getMainLoopModel()

    // Enable for firstParty
    if (provider === 'firstParty') {
      return true
    }

    // Enable for Vertex AI with supported models (AgenC 4.0+)
    if (provider === 'vertex') {
      const supportsWebSearch =
        model.includes('claude-opus-4') ||
        model.includes('claude-sonnet-4') ||
        model.includes('claude-haiku-4')

      return supportsWebSearch
    }

    // Foundry only ships models that already support Web Search
    if (provider === 'foundry') {
      return true
    }

    return false
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.query
  },
  async checkPermissions(_input): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'WebSearchTool requires permission.',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: WEB_SEARCH_TOOL_NAME }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    }
  },
  async prompt() {
    // Strip "US only" when using non-native backends
    if (shouldUseAdapterProvider() || isProviderCodeResponsesWebSearchEnabled()) {
      return getWebSearchPrompt().replace(/\n\s*-\s*Web search is only available in the US/, '')
    }
    return getWebSearchPrompt()
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  extractSearchText() {
    // renderToolResultMessage shows only "Did N searches in Xs" chrome —
    // the results[] content never appears on screen. Heuristic would index
    // string entries in results[] (phantom match). Nothing to search.
    return ''
  },
  async validateInput(input) {
    const { query, allowed_domains, blocked_domains } = input
    if (!query.length) {
      return {
        result: false,
        message: 'Error: Missing query',
        errorCode: 1,
      }
    }
    if (allowed_domains?.length && blocked_domains?.length) {
      return {
        result: false,
        message:
          'Error: Cannot specify both allowed_domains and blocked_domains in the same request',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call(input, context, _canUseTool, _parentMessage, _onProgress) {
    // --- Adapter-based providers (custom, firecrawl, ddg) ---
    // runSearch handles fallback semantics based on WEB_SEARCH_PROVIDER mode:
    //   - "auto": tries each provider, falls through on failure
    //   - specific mode: runs one provider, throws on failure
    if (shouldUseAdapterProvider()) {
      const mode = getProviderMode()
      const isExplicitAdapter = mode !== 'auto'
      try {
        const providerOutput = await runSearch(
          {
            query: input.query,
            allowed_domains: input.allowed_domains,
            blocked_domains: input.blocked_domains,
          },
          context.abortController.signal,
        )
        // Explicit adapter: return even 0 hits (no silent native fallback)
        if (isExplicitAdapter || providerOutput.hits.length > 0) {
          return { data: formatProviderOutput(providerOutput, input.query) }
        }
        // Auto mode with 0 hits: fall through to native
      } catch (err) {
        // Explicit adapter: throw the real error (no silent native fallback)
        if (isExplicitAdapter) throw err
        // Auto mode: only fall through on transient errors (network, timeout, 5xx).
        // Config / guardrail errors (SSRF, HTTPS, bad URL, etc.) must surface.
        if (!isTransientError(err)) throw err
        // No viable fallback for this provider — surface the adapter error
        // instead of falling through to a broken native path.
        if (!hasNativeSearchFallback()) {
          const provider = getAPIProvider()
          const errMsg = err instanceof Error ? err.message : String(err)
          throw new Error(
            `Web search is unavailable for provider "${provider}". ` +
              `The search adapter failed (${errMsg}). ` +
              `Try switching to a provider with built-in web search (e.g. provider, ProviderCode) or try again later.`,
          )
        }
        console.error(`[web-search] Adapter failed, falling through to native: ${err}`)
      }
    }

    // --- ProviderCode / OpenAi Responses path ---
    if (isProviderCodeResponsesWebSearchEnabled()) {
      throw new AdmissionDeniedError('legacy_web_search_model_path_disabled')
    }

    // --- Native provider path (firstParty / vertex / foundry) ---
    // This path bypasses the runtime provider/session boundary and therefore
    // cannot produce a durable reservation or authoritative reconciliation.
    // M3 fails it closed; adapter-only search above remains available.
    throw new AdmissionDeniedError('legacy_web_search_model_path_disabled')
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const { query, results } = output

    let formattedOutput = `Web search results for query: "${query}"\n\n`

    // Process the results array - it can contain both string summaries and search result objects.
    // Guard against null/undefined entries that can appear after JSON round-tripping
    // (e.g., from compaction or transcript deserialization).
    ;(results ?? []).forEach(result => {
      if (result == null) {
        return
      }
      if (typeof result === 'string') {
        // Text summary
        formattedOutput += result + '\n\n'
      } else {
        // Search result with links
        if (result.content?.length > 0) {
          formattedOutput += `Links: ${jsonStringify(result.content)}\n\n`
        } else {
          formattedOutput += 'No links found.\n\n'
        }
      }
    })
    formattedOutput +=
      '\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formattedOutput.trim(),
    }
  },
} satisfies ToolDef<InputSchema, Output, WebSearchProgress>)
