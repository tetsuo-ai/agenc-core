import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'

const originalEnv = { ...process.env }

async function importFreshModule() {
  return import(`../../../src/tools/WebFetchTool/utils.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  mock.restore()
  process.env = { ...originalEnv }
})

afterEach(() => {
  process.env = { ...originalEnv }
  mock.restore()
})

describe('checkDomainBlocklist', () => {
  test('returns allowed without API call in OpenAi mode', async () => {
    process.env.AGENC_PROVIDER = 'openai'
    const actual = await import('../../../src/utils/model/providers.ts')
    mock.module('../../../src/utils/model/providers.js', () => ({
      ...actual,
      getAPIProvider: () => 'openai',
      isFirstPartyproviderBaseUrl: () => false,
    }))
    const getSpy = mock(() =>
      Promise.resolve({ status: 200, data: { can_fetch: true } }),
    )
    axios.get = getSpy as typeof axios.get

    const { checkDomainBlocklist } = await importFreshModule()
    const result = await checkDomainBlocklist('example.com', {})

    expect(result.status).toBe('allowed')
    expect(getSpy).not.toHaveBeenCalled()
  })

  test('returns allowed without API call in Gemini mode', async () => {
    process.env.AGENC_PROVIDER = 'gemini'
    const actual = await import('../../../src/utils/model/providers.ts')
    mock.module('../../../src/utils/model/providers.js', () => ({
      ...actual,
      getAPIProvider: () => 'gemini',
      isFirstPartyproviderBaseUrl: () => false,
    }))
    const getSpy = mock(() =>
      Promise.resolve({ status: 200, data: { can_fetch: true } }),
    )
    axios.get = getSpy as typeof axios.get

    const { checkDomainBlocklist } = await importFreshModule()
    const result = await checkDomainBlocklist('example.com', {})

    expect(result.status).toBe('allowed')
    expect(getSpy).not.toHaveBeenCalled()
  })

  test('calls provider domain check in first-party mode', async () => {
    process.env.AGENC_PROVIDER = 'anthropic'

    const actual = await import('../../../src/utils/model/providers.ts')
    mock.module('../../../src/utils/model/providers.js', () => ({
      ...actual,
      getAPIProvider: () => 'firstParty',
      isFirstPartyproviderBaseUrl: () => true,
    }))
    const getSpy = mock(() =>
      Promise.resolve({ status: 200, data: { can_fetch: true } }),
    )
    axios.create = mock(() => ({ get: getSpy })) as typeof axios.create

    const { checkDomainBlocklist } = await importFreshModule()
    const result = await checkDomainBlocklist('example.com', {})

    expect(result.status).toBe('allowed')
    expect(getSpy).toHaveBeenCalledTimes(1)
  })
})
