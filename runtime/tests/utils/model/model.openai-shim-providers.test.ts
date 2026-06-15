import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { saveGlobalConfig } from '../../../src/utils/config.ts'

const providersModulePath = '../../../src/utils/model/providers.js'

async function importFreshModelModule() {
  vi.resetModules()
  vi.doMock(providersModulePath, () => ({
    getAPIProvider: () => {
      if (process.env.NVIDIA_NIM) return 'nvidia-nim'
      if (process.env.AGENC_USE_MINIMAX || process.env.MINIMAX_API_KEY) return 'minimax'
      if (process.env.AGENC_USE_GEMINI) return 'gemini'
      if (process.env.AGENC_USE_MISTRAL) return 'mistral'
      if (process.env.AGENC_USE_GITHUB) return 'github'
      if (process.env.AGENC_USE_OPENAI) {
        const baseUrl = process.env.OPENAI_BASE_URL ?? ''
        const model = process.env.OPENAI_MODEL ?? ''
        return baseUrl.includes('/backend-api/agenc') || model.startsWith('agenc')
          ? 'agenc'
          : 'openai'
      }
      return 'firstParty'
    },
  }))
  return import('../../../src/utils/model/model.ts')
}

const SAVED_ENV = {
  AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
  AGENC_USE_GEMINI: process.env.AGENC_USE_GEMINI,
  AGENC_USE_GITHUB: process.env.AGENC_USE_GITHUB,
  AGENC_USE_MISTRAL: process.env.AGENC_USE_MISTRAL,
  AGENC_USE_MINIMAX: process.env.AGENC_USE_MINIMAX,
  AGENC_USE_BEDROCK: process.env.AGENC_USE_BEDROCK,
  AGENC_USE_VERTEX: process.env.AGENC_USE_VERTEX,
  AGENC_USE_FOUNDRY: process.env.AGENC_USE_FOUNDRY,
  NVIDIA_NIM: process.env.NVIDIA_NIM,
  MISTRAL_MODEL: process.env.MISTRAL_MODEL,
  NVIDIA_MODEL: process.env.NVIDIA_MODEL,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  MINIMAX_MODEL: process.env.MINIMAX_MODEL,
  GITHUB_MODEL: process.env.GITHUB_MODEL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  XAI_API_KEY: process.env.XAI_API_KEY,
  AGENC_API_KEY: process.env.AGENC_API_KEY,
  CHATGPT_ACCOUNT_ID: process.env.CHATGPT_ACCOUNT_ID,
}

function restoreEnv(key: keyof typeof SAVED_ENV): void {
  if (SAVED_ENV[key] === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = SAVED_ENV[key]
  }
}

beforeEach(() => {
  vi.doUnmock(providersModulePath)
  vi.clearAllMocks()
  vi.resetModules()
  delete process.env.AGENC_USE_OPENAI
  delete process.env.AGENC_USE_GEMINI
  delete process.env.AGENC_USE_GITHUB
  delete process.env.AGENC_USE_MISTRAL
  delete process.env.AGENC_USE_MINIMAX
  delete process.env.AGENC_USE_BEDROCK
  delete process.env.AGENC_USE_VERTEX
  delete process.env.AGENC_USE_FOUNDRY
  delete process.env.NVIDIA_NIM
  delete process.env.MISTRAL_MODEL
  delete process.env.NVIDIA_MODEL
  delete process.env.MINIMAX_API_KEY
  delete process.env.MINIMAX_MODEL
  delete process.env.GITHUB_MODEL
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_BASE_URL
  delete process.env.XAI_API_KEY
  delete process.env.AGENC_API_KEY
  delete process.env.CHATGPT_ACCOUNT_ID
  saveGlobalConfig(current => ({
    ...current,
    model: undefined,
  }))
})

afterEach(() => {
  vi.doUnmock(providersModulePath)
  vi.clearAllMocks()
  vi.resetModules()
  for (const key of Object.keys(SAVED_ENV) as Array<keyof typeof SAVED_ENV>) {
    restoreEnv(key)
  }
  saveGlobalConfig(current => ({
    ...current,
    model: undefined,
  }))
})

test('agenc provider reads OPENAI_MODEL, not stale settings.model', async () => {
  // Regression: switching from Moonshot (settings.model='kimi-k2.6' persisted
  // from that session) to the Agenc profile. Agenc profile correctly sets
  // OPENAI_MODEL=agencplan + base URL to chatgpt.com/backend-api/agenc.
  // getUserSpecifiedModelSetting previously ignored env for 'agenc' provider
  // and returned settings.model='kimi-k2.6', causing Agenc's API to reject
  // the request: "The 'kimi-k2.6' model is not supported when using Agenc".
  saveGlobalConfig(current => ({ ...current, model: 'kimi-k2.6' }))
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://chatgpt.com/backend-api/agenc'
  process.env.OPENAI_MODEL = 'agencplan'
  process.env.AGENC_API_KEY = 'agenc-test'
  process.env.CHATGPT_ACCOUNT_ID = 'acct_test'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('agencplan')
})

test('nvidia-nim provider reads NVIDIA_MODEL, not stale OPENAI_MODEL or settings.model', async () => {
  saveGlobalConfig(current => ({ ...current, model: 'kimi-k2.6' }))
  process.env.NVIDIA_NIM = '1'
  process.env.NVIDIA_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'
  process.env.OPENAI_MODEL = 'wrong-openai-model'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
})

test('minimax provider reads MINIMAX_MODEL, not stale OPENAI_MODEL or settings.model', async () => {
  saveGlobalConfig(current => ({ ...current, model: 'kimi-k2.6' }))
  process.env.AGENC_USE_MINIMAX = '1'
  process.env.MINIMAX_API_KEY = 'minimax-test'
  process.env.AGENC_USE_OPENAI = '1'
  process.env.MINIMAX_MODEL = 'MiniMax-M2.5'
  process.env.OPENAI_MODEL = 'wrong-openai-model'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('MiniMax-M2.5')
})

test('mistral provider reads MISTRAL_MODEL, not stale OPENAI_MODEL or settings.model', async () => {
  saveGlobalConfig(current => ({ ...current, model: 'kimi-k2.6' }))
  process.env.AGENC_USE_MISTRAL = '1'
  process.env.MISTRAL_MODEL = 'devstral-latest'
  process.env.OPENAI_MODEL = 'wrong-openai-model'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('devstral-latest')
})

test('openai provider still reads OPENAI_MODEL (regression guard)', async () => {
  saveGlobalConfig(current => ({ ...current, model: 'stale-default' }))
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_MODEL = 'gpt-4o'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('gpt-4o')
})

test('github provider reads GITHUB_MODEL, not stale OPENAI_MODEL', async () => {
  saveGlobalConfig(current => ({ ...current, model: 'stale-default' }))
  process.env.AGENC_USE_GITHUB = '1'
  process.env.GITHUB_MODEL = 'github:copilot'
  process.env.OPENAI_MODEL = 'wrong-openai-model'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('github:copilot')
})

// ---------------------------------------------------------------------------
// Default model helpers — must not fall through to claude-haiku-4-5 etc. for
// openai-shim providers whose endpoints don't speak provider model names.
// Hitting that fallthrough caused WebFetch to hang for 60s on MiniMax/Agenc
// because queryHaiku() shipped an unknown model id to the shim endpoint.
// ---------------------------------------------------------------------------

test('getSmallFastModel returns MINIMAX_MODEL for MiniMax (regression: WebFetch hang)', async () => {
  process.env.AGENC_USE_MINIMAX = '1'
  process.env.MINIMAX_API_KEY = 'minimax-test'
  process.env.MINIMAX_MODEL = 'MiniMax-M2.5-highspeed'
  process.env.OPENAI_MODEL = 'wrong-openai-model'

  const { getSmallFastModel } = await importFreshModelModule()
  expect(getSmallFastModel()).toBe('MiniMax-M2.5-highspeed')
})

test('getSmallFastModel returns OPENAI_MODEL for Agenc (regression)', async () => {
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://chatgpt.com/backend-api/agenc'
  process.env.OPENAI_MODEL = 'agencspark'
  process.env.AGENC_API_KEY = 'agenc-test'
  process.env.CHATGPT_ACCOUNT_ID = 'acct_test'

  const { getSmallFastModel } = await importFreshModelModule()
  expect(getSmallFastModel()).toBe('agencspark')
})

test('getSmallFastModel returns NVIDIA_MODEL for NVIDIA NIM (regression)', async () => {
  process.env.NVIDIA_NIM = '1'
  process.env.NVIDIA_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'
  process.env.OPENAI_MODEL = 'wrong-openai-model'

  const { getSmallFastModel } = await importFreshModelModule()
  expect(getSmallFastModel()).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
})

test('getDefaultOpusModel returns MINIMAX_MODEL for MiniMax', async () => {
  process.env.AGENC_USE_MINIMAX = '1'
  process.env.MINIMAX_API_KEY = 'minimax-test'
  process.env.MINIMAX_MODEL = 'MiniMax-M2.7'
  process.env.OPENAI_MODEL = 'wrong-openai-model'

  const { getDefaultOpusModel } = await importFreshModelModule()
  expect(getDefaultOpusModel()).toBe('MiniMax-M2.7')
})

test('getDefaultSonnetModel returns NVIDIA_MODEL for NVIDIA NIM', async () => {
  process.env.NVIDIA_NIM = '1'
  process.env.NVIDIA_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'
  process.env.OPENAI_MODEL = 'wrong-openai-model'

  const { getDefaultSonnetModel } = await importFreshModelModule()
  expect(getDefaultSonnetModel()).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
})

test('getDefaultHaikuModel returns MINIMAX_MODEL for MiniMax', async () => {
  process.env.AGENC_USE_MINIMAX = '1'
  process.env.MINIMAX_API_KEY = 'minimax-test'
  process.env.MINIMAX_MODEL = 'MiniMax-M2.5-highspeed'
  process.env.OPENAI_MODEL = 'wrong-openai-model'

  const { getDefaultHaikuModel } = await importFreshModelModule()
  expect(getDefaultHaikuModel()).toBe('MiniMax-M2.5-highspeed')
})

test('default helpers do not leak agenc-* names to shim providers', async () => {
  // Umbrella guard: for each openai-shim provider, none of the default-model
  // helpers may return an provider-branded model name. That was the source
  // of the WebFetch 60s hang — MiniMax received "claude-haiku-4-5" and sat
  // on the connection.
  process.env.AGENC_USE_MINIMAX = '1'
  process.env.MINIMAX_API_KEY = 'minimax-test'
  process.env.MINIMAX_MODEL = 'MiniMax-M2.7'
  process.env.OPENAI_MODEL = 'agencplan'

  const {
    getSmallFastModel,
    getDefaultOpusModel,
    getDefaultSonnetModel,
    getDefaultHaikuModel,
  } = await importFreshModelModule()
  for (const fn of [
    getSmallFastModel,
    getDefaultOpusModel,
    getDefaultSonnetModel,
    getDefaultHaikuModel,
  ]) {
    const model = fn()
    expect(model.toLowerCase()).not.toContain('agenc')
  }
})
