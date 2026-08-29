import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'

import { resolveHomeContext } from '../../src/config/home.js'
import { CHATGPT_BACKEND_BASE_URL } from '../../src/llm/providers/openai/chatgpt-backend.js'

const credentialsModulePath = '../../src/utils/openAiOauthCredentials.js'
const boundHome = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-openai-provider-authority' },
  { platformHome: '/tmp' },
)
let stored: Record<string, unknown> | undefined
const refresh = vi.fn()

async function loadModules() {
  vi.resetModules()
  vi.doMock(credentialsModulePath, async importOriginal => ({
    ...(await importOriginal<
      typeof import('../../src/utils/openAiOauthCredentials.js')
    >()),
    readOpenAiOauthCredentials: () => stored,
    refreshOpenAiSubscriptionIfNeeded: refresh,
  }))
  const [options, provider] = await Promise.all([
    import('../../src/llm/provider-options.ts'),
    import('../../src/llm/provider.ts'),
  ])
  return { ...options, ...provider }
}

afterEach(() => {
  stored = undefined
  refresh.mockReset()
  vi.doUnmock(credentialsModulePath)
  vi.clearAllMocks()
  vi.resetModules()
})

test('stored platform credential beats the captured OpenAI env key', async () => {
  stored = { apiKey: 'stored-platform-key' }
  const { createProvider, resolveProviderFactoryOptions } = await loadModules()
  const resolved = resolveProviderFactoryOptions('openai', {
    credentialHome: boundHome,
    model: 'gpt-5',
  }, { OPENAI_API_KEY: 'environment-key' })
  expect(resolved.apiKey).toBe('stored-platform-key')
  expect(resolved.baseURL).toBe('https://api.openai.com/v1')

  const instance = createProvider('openai', resolved) as unknown as {
    config: { apiKey?: string }
  }
  expect(instance.config.apiKey).toBe('stored-platform-key')
})

test('subscription binding forces the safe backend contract', async () => {
  stored = {
    accessToken: 'subscription-access',
    refreshToken: 'subscription-refresh',
    accountId: 'account-123',
  }
  refresh.mockResolvedValue({
    refreshed: true,
    credentials: {
      accessToken: 'subscription-access-2',
      refreshToken: 'subscription-refresh-2',
      accountId: 'account-123',
    },
  })
  const { createProvider, resolveProviderFactoryOptions } = await loadModules()
  const environment = Object.freeze({ OPENAI_API_KEY: 'ignored-env-key' })
  const resolved = resolveProviderFactoryOptions('openai', {
    credentialHome: boundHome,
    model: 'gpt-5',
    extra: { store: true },
  }, environment)
  expect(resolved.apiKey).toBeUndefined()
  expect(resolved.baseURL).toBe(CHATGPT_BACKEND_BASE_URL)
  expect(resolved.extra).toMatchObject({
    authMode: 'oauth',
    store: false,
    useResponsesApi: true,
    chatgptBackend: true,
    defaultHeaders: {
      'ChatGPT-Account-ID': 'account-123',
      originator: 'agenc',
    },
  })

  const instance = createProvider('openai', resolved) as unknown as {
    config: {
      apiKey?: string
      baseURL?: string
      store?: boolean
      chatgptBackend?: boolean
    }
  }
  expect(instance.config).toMatchObject({
    baseURL: CHATGPT_BACKEND_BASE_URL,
    store: false,
    chatgptBackend: true,
  })
  expect(instance.config.apiKey).toBeUndefined()

  const oauth = resolved.extra?.oauth as {
    refreshAccessToken: () => Promise<unknown>
  }
  await expect(oauth.refreshAccessToken()).resolves.toMatchObject({
    kind: 'refreshed',
    accessToken: 'subscription-access-2',
  })
  expect(refresh).toHaveBeenCalledWith(boundHome, environment, { force: true })
})

test('OAuth binding rejects a custom OpenAI endpoint', async () => {
  stored = { apiKey: 'stored-platform-key' }
  const { resolveProviderFactoryOptions } = await loadModules()
  expect(() => resolveProviderFactoryOptions('openai', {
    credentialHome: boundHome,
    model: 'gpt-5',
    baseURL: 'https://attacker.example/v1',
  }, {})).toThrow(/bound to the first-party OpenAI endpoint/)
})

test('factory and adapter contain no native secure-storage reads', () => {
  for (const path of [
    new URL('../../src/llm/provider.ts', import.meta.url),
    new URL('../../src/llm/providers/openai/adapter.ts', import.meta.url),
  ]) {
    const source = readFileSync(path, 'utf8')
    expect(source).not.toContain('openAiOauthCredentials')
    expect(source).not.toContain('getSecureStorage')
    expect(source).not.toContain('process.env')
  }
})
