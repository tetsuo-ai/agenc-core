import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { sourceUrl } from '../helpers/source-path.ts'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

async function importFreshModule() {
  mock.restore()
  const url = sourceUrl('utils/apiPreconnect.ts')
  url.search = `ts=${Date.now()}-${Math.random()}`
  return import(url.href)
}

function providerModule(provider: string) {
  return {
    getAPIProvider: () => provider,
    usesAnthropicAccountFlow: () => false,
    isGithubNativeAnthropicMode: () => false,
    getAPIProviderForStatsig: () => provider,
    isFirstPartyAnthropicBaseUrl: () => provider === 'firstParty',
    isFirstPartyproviderBaseUrl: () => provider === 'firstParty',
    isGithubNativeproviderMode: () => false,
  }
}

beforeEach(() => {
  process.env = { ...originalEnv }
})

afterEach(() => {
  process.env = { ...originalEnv }
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('preconnectAnthropicApi', () => {
  test('fetches in first-party mode', async () => {
    delete process.env.AGENC_USE_OPENAI
    delete process.env.AGENC_USE_GEMINI
    delete process.env.AGENC_USE_GITHUB
    delete process.env.AGENC_USE_BEDROCK
    delete process.env.AGENC_USE_VERTEX
    delete process.env.AGENC_USE_FOUNDRY
    delete process.env.HTTPS_PROXY
    delete process.env.https_proxy
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy
    delete process.env.ANTHROPIC_UNIX_SOCKET
    delete process.env.AGENC_CLIENT_CERT
    delete process.env.AGENC_CLIENT_KEY

    mock.module(sourceUrl('utils/model/providers.js').href, () =>
      providerModule('firstParty'),
    )
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does not fetch when openai mode is enabled', async () => {
    process.env.AGENC_USE_OPENAI = '1'
    mock.module(sourceUrl('utils/model/providers.js').href, () =>
      providerModule('openai'),
    )
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('does not fetch when Gemini mode is enabled', async () => {
    process.env.AGENC_USE_GEMINI = '1'
    mock.module(sourceUrl('utils/model/providers.js').href, () =>
      providerModule('gemini'),
    )
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('does not fetch when GitHub mode is enabled', async () => {
    process.env.AGENC_USE_GITHUB = '1'
    mock.module(sourceUrl('utils/model/providers.js').href, () =>
      providerModule('github'),
    )
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
