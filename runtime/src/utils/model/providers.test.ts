import { afterEach, expect, test } from 'bun:test'

const originalEnv = {
  AGENC_USE_GEMINI: process.env.AGENC_USE_GEMINI,
  AGENC_USE_GITHUB: process.env.AGENC_USE_GITHUB,
  AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
  AGENC_USE_BEDROCK: process.env.AGENC_USE_BEDROCK,
  AGENC_USE_VERTEX: process.env.AGENC_USE_VERTEX,
  AGENC_USE_FOUNDRY: process.env.AGENC_USE_FOUNDRY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  XAI_API_KEY: process.env.XAI_API_KEY,
}

afterEach(() => {
  process.env.AGENC_USE_GEMINI = originalEnv.AGENC_USE_GEMINI
  process.env.AGENC_USE_GITHUB = originalEnv.AGENC_USE_GITHUB
  process.env.AGENC_USE_OPENAI = originalEnv.AGENC_USE_OPENAI
  process.env.AGENC_USE_BEDROCK = originalEnv.AGENC_USE_BEDROCK
  process.env.AGENC_USE_VERTEX = originalEnv.AGENC_USE_VERTEX
  process.env.AGENC_USE_FOUNDRY = originalEnv.AGENC_USE_FOUNDRY
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.OPENAI_API_BASE = originalEnv.OPENAI_API_BASE
  process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  process.env.XAI_API_KEY = originalEnv.XAI_API_KEY
})

async function importFreshProvidersModule() {
  return import(`./providers.js?ts=${Date.now()}-${Math.random()}`)
}

function clearProviderEnv(): void {
  delete process.env.AGENC_USE_GEMINI
  delete process.env.AGENC_USE_GITHUB
  delete process.env.AGENC_USE_OPENAI
  delete process.env.AGENC_USE_BEDROCK
  delete process.env.AGENC_USE_VERTEX
  delete process.env.AGENC_USE_FOUNDRY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_MODEL
  delete process.env.XAI_API_KEY
}

test('first-party provider keeps provider account setup flow enabled', () => {
  clearProviderEnv()
  return importFreshProvidersModule().then(
    ({ getAPIProvider, usesAnthropicAccountFlow }) => {
      expect(getAPIProvider()).toBe('firstParty')
      expect(usesAnthropicAccountFlow()).toBe(true)
    },
  )
})

test.each([
  ['AGENC_USE_OPENAI', 'openai'],
  ['AGENC_USE_GITHUB', 'github'],
  ['AGENC_USE_GEMINI', 'gemini'],
  ['AGENC_USE_BEDROCK', 'bedrock'],
  ['AGENC_USE_VERTEX', 'vertex'],
  ['AGENC_USE_FOUNDRY', 'foundry'],
] as const)(
  '%s disables provider account setup flow',
  async (envKey, provider) => {
    clearProviderEnv()
    process.env[envKey] = '1'
    const { getAPIProvider, usesAnthropicAccountFlow } =
      await importFreshProvidersModule()

    expect(getAPIProvider()).toBe(provider)
    expect(usesAnthropicAccountFlow()).toBe(false)
  },
)

test('GEMINI takes precedence over GitHub when both are set', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_GEMINI = '1'
  process.env.AGENC_USE_GITHUB = '1'
  const { getAPIProvider } = await importFreshProvidersModule()

  expect(getAPIProvider()).toBe('gemini')
})

test('explicit local openai-compatible base URLs stay on the openai provider', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('openai')
})

test('agenc aliases still resolve to the agenc provider without a non-agenc base URL', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_MODEL = 'agencplan'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('agenc')
})

test('XAI_API_KEY resolves to the xai provider', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_OPENAI = '1'
  process.env.XAI_API_KEY = 'xai-test-key'
  process.env.OPENAI_BASE_URL = 'https://api.x.ai/v1'
  process.env.OPENAI_MODEL = 'grok-4'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('xai')
})

test('official openai base URLs now keep provider detection on openai for aliases', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('openai')
})

// isGithubNativeAnthropicMode

test('isGithubNativeAnthropicMode: false when AGENC_USE_GITHUB is not set', async () => {
  clearProviderEnv()
  process.env.OPENAI_MODEL = 'claude-sonnet-4-5'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: true for bare agenc- model via OPENAI_MODEL', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'claude-sonnet-4-5'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(true)
})

test('isGithubNativeAnthropicMode: true for github:copilot:agenc- compound format', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot:claude-sonnet-4'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(true)
})

test('isGithubNativeAnthropicMode: true when resolvedModel is a agenc- model', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode('claude-haiku-4-5')).toBe(true)
})

test('isGithubNativeAnthropicMode: false for generic github:copilot alias', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: false for non-AgenC model', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'gpt-4o'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: false for github:copilot:gpt- model', async () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot:gpt-4o'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})
