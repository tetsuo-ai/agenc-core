import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelFacingTools, type ModelFacingToolOptions } from '../../src/bin/model-facing-tools.js'
import type { Session } from '../../src/session/session.js'
import { snapshotProviderEnvironment } from '../../src/llm/provider-environment.js'
import { summarizeWebSearchResult } from '../../src/tui/tool-result-routing.js'

const hit = { title: 'Fixture source', url: 'https://docs.example/page', snippet: 'Fixture search evidence' }
const fixtures = [
  ['firecrawl', 'FIRECRAWL_API_KEY', 'api.firecrawl.dev', 'Authorization', 'Bearer fixture', { success: true, data: { web: [hit] } }],
  ['tavily', 'TAVILY_API_KEY', 'api.tavily.com', 'Authorization', 'Bearer fixture', { results: [hit] }],
  ['exa', 'EXA_API_KEY', 'api.exa.ai', 'x-api-key', 'fixture', { results: [hit] }],
  ['you', 'YOU_API_KEY', 'api.ydc-index.io', 'X-API-Key', 'fixture', { results: { web: [hit] } }],
  ['jina', 'JINA_API_KEY', 's.jina.ai', 'Authorization', 'Bearer fixture', { data: [hit] }],
  ['bing', 'BING_API_KEY', 'api.bing.microsoft.com', 'Ocp-Apim-Subscription-Key', 'fixture', { webPages: { value: [hit] } }],
  ['mojeek', 'MOJEEK_API_KEY', 'www.mojeek.com', 'Authorization', 'Bearer fixture', { response: { results: [hit] } }],
  ['linkup', 'LINKUP_API_KEY', 'api.linkup.so', 'Authorization', 'Bearer fixture', { results: [hit] }],
  ['keenable', 'KEENABLE_API_KEY', 'api.keenable.ai', 'X-API-Key', 'fixture', { results: [hit] }],
] as const

function tool(env: NodeJS.ProcessEnv = {}, toolsConfig?: ModelFacingToolOptions['toolsConfig']) {
  return createModelFacingTools({
    workspaceRoot: process.cwd(), getSession: () => null,
    env: snapshotProviderEnvironment(env), ...(toolsConfig ? { toolsConfig } : {}),
  }).find(t => t.name === 'WebSearch')!
}
const response = (body: unknown) => new Response(JSON.stringify(body))
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('configured providers in live WebSearch', () => {
  it.each(fixtures)('%s is selected from the forwarded session key with its HTTP format and source display', async (name, key, host, header, auth, body) => {
    const fetch = vi.fn(async () => response(body))
    vi.stubGlobal('fetch', fetch)
    const search = tool({ [key]: 'fixture' })
    expect(search.admissionEstimate?.({ query: 'fixture' }).maxCostUsd).toBeNull()
    const result = await search.execute({ query: 'fixture', max_results: 1 })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(url).hostname).toBe(host)
    expect(new Headers(init.headers).get(header)).toBe(auth)
    expect(init.redirect).toBe('error')
    expect(JSON.parse(result.content)).toMatchObject({ source: name, results: [hit] })
    expect(result.admissionUsage).toBeUndefined() // no receipt: never claim a paid search was free
    expect(summarizeWebSearchResult(result.content)).toMatchObject({ source: name === 'you' ? 'You.com' : name[0].toUpperCase() + name.slice(1), results: [{ title: hit.title, url: hit.url }] })
  })

  it('uses DeepSeek before keyed providers and preserves its fallback reason and unpriced admission', async () => {
    const fetch = vi.fn(async (url: string) => url.includes('deepseek.com')
      ? new Response('unavailable', { status: 503 }) : response({ results: [hit] }))
    vi.stubGlobal('fetch', fetch)
    const session = { services: { provider: { name: 'deepseek', config: {
      apiKey: 'deepseek-fixture', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash',
    } } } } as unknown as Session
    const search = createModelFacingTools({ workspaceRoot: process.cwd(), getSession: () => session,
      env: { TAVILY_API_KEY: 'fixture' },
    }).find(t => t.name === 'WebSearch')!
    expect(search.admissionEstimate?.({ query: 'news' }).maxCostUsd).toBeNull()
    const result = await search.execute({ query: 'news' })
    expect(fetch.mock.calls.map(c => new URL(c[0]).hostname)).toEqual(['api.deepseek.com', 'api.tavily.com'])
    expect(JSON.parse(result.content)).toMatchObject({ source: 'tavily', deepseek_search_fallback: expect.stringContaining('503') })
    expect(result.admissionUsage).toBeUndefined()
  })

  it('keeps an exact DeepSeek receipt when it succeeds before the configured paid fallback', async () => {
    const fetch = vi.fn(async () => response({ results: [hit] }))
    vi.stubGlobal('fetch', fetch)
    const session = { services: { provider: { name: 'deepseek', config: {
      apiKey: 'deepseek-fixture', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash',
    } } } } as unknown as Session
    const search = createModelFacingTools({ workspaceRoot: process.cwd(), getSession: () => session,
      env: { TAVILY_API_KEY: 'fixture' },
    }).find(t => t.name === 'WebSearch')!
    expect(search.admissionEstimate?.({ query: 'news' }).maxCostUsd).toBeNull()
    const result = await search.execute({ query: 'news' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(result.content).source).toBe('deepseek_search')
    expect(result.admissionUsage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0.00075 })
  })

  it('accepts config selection and endpoint, with environment overrides taking precedence', async () => {
    const fetch = vi.fn(async () => response({ results: [hit] }))
    vi.stubGlobal('fetch', fetch)
    const config = { web_search_provider: 'exa', web_search_endpoint: 'http://127.0.0.1:1234/exa' }
    const first = await tool({ EXA_API_KEY: 'config-fixture' }, config).execute({ query: 'one' })
    const second = await tool({ TAVILY_API_KEY: 'env-fixture', WEB_SEARCH_PROVIDER: 'tavily', AGENC_WEB_SEARCH_ENDPOINT: 'http://127.0.0.1:1234/tavily' }, config).execute({ query: 'two' })
    expect(JSON.parse(first.content).source).toBe('exa')
    expect(JSON.parse(second.content).source).toBe('tavily')
    expect(fetch.mock.calls.map(c => String(c[0]))).toEqual(['http://127.0.0.1:1234/exa', 'http://127.0.0.1:1234/tavily'])
  })

  it('tries configured keys in shared priority order, then DDG on HTTP, malformed and empty responses', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('firecrawl')) return new Response('unavailable', { status: 503 })
      if (url.includes('tavily')) return new Response('invalid json')
      if (url.includes('exa')) return response({ results: [] })
      return new Response(`<a class="result__a" href="${hit.url}">${hit.title}</a>`)
    })
    vi.stubGlobal('fetch', fetch)
    const result = await tool({ FIRECRAWL_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture', EXA_API_KEY: 'fixture' }).execute({ query: 'news' })
    expect(fetch.mock.calls.map(c => new URL(c[0]).hostname)).toEqual(['api.firecrawl.dev', 'api.tavily.com', 'api.exa.ai', 'html.duckduckgo.com'])
    expect(JSON.parse(result.content).source).toBe('duckduckgo_html')
    expect(result.admissionUsage).toBeUndefined()
  })

  it('keeps explicit endpoint priority in auto mode and never enables custom presets implicitly', async () => {
    const fetch = vi.fn(async () => response({ results: [hit] }))
    vi.stubGlobal('fetch', fetch)
    await tool({ TAVILY_API_KEY: 'fixture', AGENC_WEB_SEARCH_ENDPOINT: 'https://search.example', AGENC_WEB_SEARCH_KIND: 'json', WEB_PROVIDER: 'brave', WEB_KEY: 'fixture' }).execute({ query: 'news' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(String(fetch.mock.calls[0]?.[0])).toContain('https://search.example')
  })

  it('fails explicit adapters without switching backend or leaking HTTP bodies', async () => {
    const fetch = vi.fn(async () => new Response('sensitive-fixture', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    await expect(tool({ WEB_SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'sensitive-fixture', EXA_API_KEY: 'fixture' }).execute({ query: 'news' })).rejects.toThrow('Search provider "tavily" failed')
    expect(fetch).toHaveBeenCalledOnce()
    await expect(tool({ WEB_SEARCH_PROVIDER: 'exa' }).execute({ query: 'news' })).rejects.toThrow('not configured')
    await expect(tool({ WEB_SEARCH_PROVIDER: 'invalid' }).execute({ query: 'news' })).rejects.toThrow('Unknown web search provider')
  })

  it('runs explicit Keenable without a key on its keyless endpoint and leaves it out of auto', async () => {
    const fetch = vi.fn(async (url: string) => url.includes('keenable')
      ? response({ results: [{ ...hit, description: '', snippet: 'Fixture\n\nsearch   evidence' }] })
      : new Response(`<a class="result__a" href="${hit.url}">${hit.title}</a>`))
    vi.stubGlobal('fetch', fetch)
    const result = await tool({ WEB_SEARCH_PROVIDER: 'keenable' }).execute({ query: 'fixture', max_results: 3, allowed_domains: ['docs.example'] })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.keenable.ai/v1/search/public')
    expect(new Headers(init.headers).get('X-Keenable-Title')).toBe('AgenC')
    expect(new Headers(init.headers).has('X-API-Key')).toBe(false)
    expect(init.redirect).toBe('error')
    expect(JSON.parse(String(init.body))).toEqual({ query: 'fixture', max_results: 3, site: 'docs.example' })
    expect(JSON.parse(result.content)).toMatchObject({ source: 'keenable', results: [hit] })

    fetch.mockClear()
    await tool({}).execute({ query: 'news' })
    expect(fetch.mock.calls.map(c => new URL(c[0]).hostname)).toEqual(['html.duckduckgo.com'])
  })

  it('tries Keenable last among configured keys, on its keyed endpoint', async () => {
    const fetch = vi.fn(async (url: string) => url.includes('linkup')
      ? new Response('unavailable', { status: 503 }) : response({ results: [hit] }))
    vi.stubGlobal('fetch', fetch)
    const result = await tool({ KEENABLE_API_KEY: 'fixture', LINKUP_API_KEY: 'fixture' }).execute({ query: 'news' })
    expect(fetch.mock.calls.map(c => String(c[0]))).toEqual(['https://api.linkup.so/v1/search', 'https://api.keenable.ai/v1/search'])
    expect(JSON.parse(result.content).source).toBe('keenable')
  })

  it('runs custom presets with the live session environment', async () => {
    const fetch = vi.fn(async () => response({ web: { results: [hit] } }))
    vi.stubGlobal('fetch', fetch)
    const result = await tool({ WEB_SEARCH_PROVIDER: 'custom', WEB_PROVIDER: 'brave', WEB_KEY: 'custom-fixture', WEB_AUTH_SCHEME: '' }).execute({ query: 'news' })
    expect(JSON.parse(result.content).source).toBe('custom')
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(url).hostname).toBe('api.search.brave.com')
    expect(new Headers(init.headers).get('X-Subscription-Token')).toBe('custom-fixture')
  })

  it('filters domains and unsafe URLs and bounds snippets and result count', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ results: [
      { ...hit, url: 'javascript:alert(1)' },
      { ...hit, url: 'https://blocked.example/page' },
      { ...hit, url: 'https://badexample/page' },
      { ...hit, snippet: 'x'.repeat(2000) }, hit,
    ] })))
    const result = await tool({ EXA_API_KEY: 'fixture' }).execute({ query: 'news', allowed_domains: ['example'], blocked_domains: ['blocked.example'], max_results: 1 })
    const parsed = JSON.parse(result.content)
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].url).toBe(hit.url)
    expect(parsed.results[0].snippet).toHaveLength(600)
  })

  it('does not read process credentials and keeps concurrent sessions isolated', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', 'ambient-secret')
    const fetch = vi.fn(async () => { await Promise.resolve(); return response({ results: [hit] }) })
    vi.stubGlobal('fetch', fetch)
    await Promise.all(['one', 'two'].map(key => tool({ TAVILY_API_KEY: key }).execute({ query: key })))
    expect(fetch.mock.calls.map(c => new Headers((c[1] as RequestInit).headers).get('Authorization')).sort()).toEqual(['Bearer one', 'Bearer two'])
    expect(fetch.mock.calls.every(c => String(c[0]).includes('tavily'))).toBe(true)
  })

  it('cancels without trying another provider', async () => {
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    const fetch = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetch)
    const pending = tool({ TAVILY_API_KEY: 'fixture', EXA_API_KEY: 'fixture' }).execute({ query: 'news', __abortSignal: controller.signal })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(fetch).toHaveBeenCalledOnce()
  })
})
