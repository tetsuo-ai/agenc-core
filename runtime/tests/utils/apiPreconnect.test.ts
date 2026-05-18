import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

async function importFreshModule() {
  mock.restore()
  return import(`./apiPreconnect.ts?ts=${Date.now()}-${Math.random()}`)
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
  test('does not fetch when openai mode is enabled', async () => {
    process.env.AGENC_USE_OPENAI = '1'
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('does not fetch when Gemini mode is enabled', async () => {
    process.env.AGENC_USE_GEMINI = '1'
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'gemini',
    }))
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('does not fetch when GitHub mode is enabled', async () => {
    process.env.AGENC_USE_GITHUB = '1'
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'github',
    }))
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('fetches in first-party mode', async () => {
    delete process.env.AGENC_USE_OPENAI
    delete process.env.AGENC_USE_GEMINI
    delete process.env.AGENC_USE_GITHUB
    delete process.env.AGENC_USE_BEDROCK
    delete process.env.AGENC_USE_VERTEX
    delete process.env.AGENC_USE_FOUNDRY

    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'firstParty',
    }))
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
