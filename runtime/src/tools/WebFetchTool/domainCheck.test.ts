import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'

const originalEnv = { ...process.env }

async function importFreshModule() {
  mock.restore()
  return import(`./utils.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  process.env = { ...originalEnv }
})

afterEach(() => {
  process.env = { ...originalEnv }
  mock.restore()
})

describe('checkDomainBlocklist', () => {
  test('returns allowed without API call in OpenAi mode', async () => {
    process.env.AGENC_USE_OPENAI = '1'
    const actual = await import('../../utils/model/providers.js')
    mock.module('../../utils/model/providers.js', () => ({
      ...actual,
      getAPIProvider: () => 'openai',
      isFirstPartyproviderBaseUrl: () => false,
    }))
    const getSpy = mock(() =>
      Promise.resolve({ status: 200, data: { can_fetch: true } }),
    )
    axios.get = getSpy as typeof axios.get

    const { checkDomainBlocklist } = await importFreshModule()
    const result = await checkDomainBlocklist('example.com')

    expect(result.status).toBe('allowed')
    expect(getSpy).not.toHaveBeenCalled()
  })

  test('returns allowed without API call in Gemini mode', async () => {
    process.env.AGENC_USE_GEMINI = '1'
    const actual = await import('../../utils/model/providers.js')
    mock.module('../../utils/model/providers.js', () => ({
      ...actual,
      getAPIProvider: () => 'gemini',
      isFirstPartyproviderBaseUrl: () => false,
    }))
    const getSpy = mock(() =>
      Promise.resolve({ status: 200, data: { can_fetch: true } }),
    )
    axios.get = getSpy as typeof axios.get

    const { checkDomainBlocklist } = await importFreshModule()
    const result = await checkDomainBlocklist('example.com')

    expect(result.status).toBe('allowed')
    expect(getSpy).not.toHaveBeenCalled()
  })

  test('calls provider domain check in first-party mode', async () => {
    delete process.env.AGENC_USE_OPENAI
    delete process.env.AGENC_USE_GEMINI
    delete process.env.AGENC_USE_GITHUB

    const actual = await import('../../utils/model/providers.js')
    mock.module('../../utils/model/providers.js', () => ({
      ...actual,
      getAPIProvider: () => 'firstParty',
      isFirstPartyproviderBaseUrl: () => true,
    }))
    const getSpy = mock(() =>
      Promise.resolve({ status: 200, data: { can_fetch: true } }),
    )
    axios.get = getSpy as typeof axios.get

    const { checkDomainBlocklist } = await importFreshModule()
    const result = await checkDomainBlocklist('example.com')

    expect(result.status).toBe('allowed')
    expect(getSpy).toHaveBeenCalledTimes(1)
  })
})
