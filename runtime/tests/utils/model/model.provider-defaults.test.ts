import { afterEach, beforeEach, expect, test, vi } from 'vitest'

async function importFreshModelModule() {
  vi.resetModules()
  const [
    module,
    { runWithStartupProviderSelection },
    { ConfigStore },
    { runWithCanonicalSettingsAuthority },
  ] = await Promise.all([
    import('../../../src/utils/model/model.ts'),
    import('../../../src/utils/model/providers.ts'),
    import('../../../src/config/store.ts'),
    import('../../../src/utils/settings/canonicalAuthority.ts'),
  ])
  const provider = process.env.AGENC_PROVIDER
  if (!provider) throw new Error('test provider must be selected before import')
  const selectedModel = process.env.AGENC_MODEL ?? 'test-model'
  const store = new ConfigStore({
    home: '/tmp/agenc-model-provider-defaults',
    env: {},
    base: {},
  })
  return new Proxy(module, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function'
        ? (...args: unknown[]) =>
            runWithCanonicalSettingsAuthority(store, () =>
              runWithStartupProviderSelection({ provider, model: selectedModel, environment: { ...process.env } }, () => value(...args)),
            )
        : value
    },
  })
}

const SAVED_ENV = {
  AGENC_PROVIDER: process.env.AGENC_PROVIDER,
  AGENC_MODEL: process.env.AGENC_MODEL,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
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
  vi.clearAllMocks()
  vi.resetModules()
  delete process.env.AGENC_PROVIDER
  delete process.env.AGENC_MODEL
  delete process.env.MINIMAX_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.XAI_API_KEY
  delete process.env.AGENC_API_KEY
  delete process.env.CHATGPT_ACCOUNT_ID
})

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  for (const key of Object.keys(SAVED_ENV) as Array<keyof typeof SAVED_ENV>) {
    restoreEnv(key)
  }
})

test('agenc provider reads the canonical startup model', async () => {
  process.env.AGENC_PROVIDER = 'agenc'
  process.env.OPENAI_BASE_URL = 'https://chatgpt.com/backend-api/agenc'
  process.env.AGENC_MODEL = 'agenc'
  process.env.AGENC_API_KEY = 'agenc-test'
  process.env.CHATGPT_ACCOUNT_ID = 'acct_test'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('agenc')
})

test('nvidia-nim provider reads the canonical startup model', async () => {
  process.env.AGENC_PROVIDER = 'nvidia-nim'
  process.env.AGENC_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
})

test('minimax provider reads the canonical startup model', async () => {
  process.env.AGENC_PROVIDER = 'minimax'
  process.env.MINIMAX_API_KEY = 'minimax-test'
  process.env.AGENC_MODEL = 'MiniMax-M2.5'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('MiniMax-M2.5')
})

test('mistral provider reads the canonical startup model', async () => {
  process.env.AGENC_PROVIDER = 'mistral'
  process.env.AGENC_MODEL = 'mistral-medium-latest'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('mistral-medium-latest')
})

test('openai provider reads the canonical startup model', async () => {
  process.env.AGENC_PROVIDER = 'openai'
  process.env.AGENC_MODEL = 'gpt-4o'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('gpt-4o')
})

test('github provider reads the canonical startup model', async () => {
  process.env.AGENC_PROVIDER = 'github'
  process.env.AGENC_MODEL = 'github:copilot'

  const { getUserSpecifiedModelSetting } = await importFreshModelModule()
  const model = getUserSpecifiedModelSetting()
  expect(model).toBe('github:copilot')
})

// ---------------------------------------------------------------------------
// Default model helpers must preserve the canonical model selected for each
// provider. A provider-specific fallback can send an invalid model identifier
// and stall an otherwise healthy request.
// ---------------------------------------------------------------------------

test('getSmallFastModel returns the canonical MiniMax model (regression: WebFetch hang)', async () => {
  process.env.AGENC_PROVIDER = 'minimax'
  process.env.MINIMAX_API_KEY = 'minimax-test'
  process.env.AGENC_MODEL = 'MiniMax-M2.5-highspeed'

  const { getSmallFastModel } = await importFreshModelModule()
  expect(getSmallFastModel()).toBe('MiniMax-M2.5-highspeed')
})

test('getSmallFastModel returns the canonical AgenC model (regression)', async () => {
  process.env.AGENC_PROVIDER = 'agenc'
  process.env.OPENAI_BASE_URL = 'https://chatgpt.com/backend-api/agenc'
  process.env.AGENC_MODEL = 'agenc'
  process.env.AGENC_API_KEY = 'agenc-test'
  process.env.CHATGPT_ACCOUNT_ID = 'acct_test'

  const { getSmallFastModel } = await importFreshModelModule()
  expect(getSmallFastModel()).toBe('agenc')
})

test('getSmallFastModel returns the canonical NVIDIA NIM model (regression)', async () => {
  process.env.AGENC_PROVIDER = 'nvidia-nim'
  process.env.AGENC_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'

  const { getSmallFastModel } = await importFreshModelModule()
  expect(getSmallFastModel()).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
})

test('getDefaultOpusModel returns the canonical MiniMax model', async () => {
  process.env.AGENC_PROVIDER = 'minimax'
  process.env.MINIMAX_API_KEY = 'minimax-test'
  process.env.AGENC_MODEL = 'MiniMax-M2.7'

  const { getDefaultOpusModel } = await importFreshModelModule()
  expect(getDefaultOpusModel()).toBe('MiniMax-M2.7')
})

test('getDefaultSonnetModel returns the canonical NVIDIA NIM model', async () => {
  process.env.AGENC_PROVIDER = 'nvidia-nim'
  process.env.AGENC_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'

  const { getDefaultSonnetModel } = await importFreshModelModule()
  expect(getDefaultSonnetModel()).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
})

test('getDefaultHaikuModel returns the canonical MiniMax model', async () => {
  process.env.AGENC_PROVIDER = 'minimax'
  process.env.MINIMAX_API_KEY = 'minimax-test'
  process.env.AGENC_MODEL = 'MiniMax-M2.5-highspeed'

  const { getDefaultHaikuModel } = await importFreshModelModule()
  expect(getDefaultHaikuModel()).toBe('MiniMax-M2.5-highspeed')
})

test('default helpers do not leak agenc-* names to other providers', async () => {
  // Umbrella guard: provider-default helpers must not return a model name
  // belonging to a different provider. That was the source
  // of the WebFetch 60s hang — MiniMax received "claude-haiku-4-5" and sat
  // on the connection.
  process.env.AGENC_PROVIDER = 'minimax'
  process.env.MINIMAX_API_KEY = 'minimax-test'
  process.env.AGENC_MODEL = 'MiniMax-M2.7'

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
