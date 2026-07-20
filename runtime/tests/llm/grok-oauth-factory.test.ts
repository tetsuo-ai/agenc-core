import { afterEach, beforeEach, expect, test, vi } from 'vitest'

/**
 * Factory wiring for Sign in with X / xAI OAuth: with no API key, the grok
 * provider falls back to the stored subscription bearer, installs the I-14
 * auth-refresh callbacks, and refuses to ship the bearer to non-xAI hosts.
 */

const credentialsModulePath = '../../src/utils/xaiOauthCredentials.js'

let storedAccessToken: string | undefined
let requiresRelogin = true
const forceRefreshMock = vi.fn()

async function importProviderModule() {
  vi.resetModules()
  vi.doMock(credentialsModulePath, () => ({
    readXaiOauthAccessToken: () => storedAccessToken,
    isXaiOauthBearer: (key: string | undefined) =>
      key !== undefined && key === storedAccessToken,
    forceRefreshXaiOauthCredentials: forceRefreshMock,
    xaiOauthRequiresRelogin: () => requiresRelogin,
  }))
  return import('../../src/llm/provider.ts')
}

beforeEach(() => {
  storedAccessToken = undefined
  requiresRelogin = true
  forceRefreshMock.mockReset()
})

afterEach(() => {
  vi.doUnmock(credentialsModulePath)
  vi.clearAllMocks()
  vi.resetModules()
})

test('grok without apiKey falls back to the stored OAuth bearer', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProvider } = await importProviderModule()

  const provider = createProvider('grok', { model: 'grok-4.5' })
  expect(provider.name).toBe('grok')
})

test('grok without apiKey and without stored OAuth still requires a key', async () => {
  storedAccessToken = undefined
  const { createProvider } = await importProviderModule()

  expect(() => createProvider('grok', { model: 'grok-4.5' })).toThrow(
    /requires apiKey/,
  )
})

test('/grok-login OAuth wins over an explicit env-style apiKey', async () => {
  // Product rule: signing in with X means subscription access — leftover
  // XAI_API_KEY / factory apiKey must not shadow the OAuth bearer.
  // Prove OAuth is active: non-xAI base URL is refused even when apiKey is set
  // (pure BYOK mode would allow custom gateways).
  storedAccessToken = 'oauth-bearer-1'
  const { createProvider } = await importProviderModule()

  expect(() =>
    createProvider('grok', {
      apiKey: 'xai-real-key',
      model: 'grok-4.5',
      baseURL: 'https://attacker.example/v1',
    }),
  ).toThrow(/refusing to send the xAI OAuth bearer/)

  const provider = createProvider('grok', {
    apiKey: 'xai-real-key',
    model: 'grok-4.5',
  })
  expect(provider.name).toBe('grok')
})

test('OAuth bearer is refused for non-xAI base URLs', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProvider } = await importProviderModule()

  expect(() =>
    createProvider('grok', {
      model: 'grok-4.5',
      baseURL: 'https://attacker.example/v1',
    }),
  ).toThrow(/refusing to send the xAI OAuth bearer/)
})

test('OAuth bearer is allowed for the grok.com CLI proxy base URL', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProvider } = await importProviderModule()

  const provider = createProvider('grok', {
    model: 'grok-4.5',
    baseURL: 'https://cli-chat-proxy.grok.com/v1',
  })
  expect(provider.name).toBe('grok')
})

test('API-key mode is exempt from the OAuth base URL pin', async () => {
  storedAccessToken = undefined
  const { createProvider } = await importProviderModule()

  const provider = createProvider('grok', {
    apiKey: 'xai-real-key',
    model: 'grok-4.5',
    baseURL: 'https://my-gateway.example/v1',
  })
  expect(provider.name).toBe('grok')
})

test('OAuth mode installs a working 401 refresh callback', async () => {
  storedAccessToken = 'oauth-bearer-1'
  forceRefreshMock.mockResolvedValue({ accessToken: 'oauth-bearer-2' })
  const { createProvider } = await importProviderModule()

  const provider = createProvider('grok', { model: 'grok-4.5' }) as unknown as {
    authRefreshCallbacks?: {
      refreshBearer: (ctx: unknown) => Promise<{ kind: string; bearer?: string }>
    }
  }
  const callbacks = provider.authRefreshCallbacks
  expect(callbacks).toBeDefined()

  const outcome = await callbacks!.refreshBearer({
    attempt: 1,
    previousError: Object.assign(new Error('401'), { status: 401 }),
  })
  expect(outcome).toEqual({ kind: 'refreshed', bearer: 'oauth-bearer-2' })
  expect(forceRefreshMock).toHaveBeenCalledTimes(1)
})

test('exhausted refresh reports a re-login hint instead of retrying', async () => {
  storedAccessToken = 'oauth-bearer-1'
  forceRefreshMock.mockResolvedValue(undefined)
  const { createProvider } = await importProviderModule()

  const provider = createProvider('grok', { model: 'grok-4.5' }) as unknown as {
    authRefreshCallbacks?: {
      refreshBearer: (ctx: unknown) => Promise<{ kind: string; reason?: string }>
    }
  }
  const outcome = await provider.authRefreshCallbacks!.refreshBearer({
    attempt: 1,
    previousError: Object.assign(new Error('401'), { status: 401 }),
  })
  expect(outcome.kind).toBe('exhausted')
  expect(outcome.reason).toMatch(/run \/grok-login/)
  expect(outcome.reason).toMatch(/expired/)
})

test('transient refresh failure does not claim the user is logged out', async () => {
  // The live failure this pins: a refresh that fails while the stored grant
  // is still viable (network blip, endpoint 5xx, sibling-process race) used
  // to surface "run /grok-login to sign in again" and flap the TUI to
  // "Not logged in" mid-session. Honesty: only a dead grant may demand
  // re-login.
  storedAccessToken = 'oauth-bearer-1'
  requiresRelogin = false
  forceRefreshMock.mockResolvedValue(undefined)
  const { createProvider } = await importProviderModule()

  const provider = createProvider('grok', { model: 'grok-4.5' }) as unknown as {
    authRefreshCallbacks?: {
      refreshBearer: (ctx: unknown) => Promise<{ kind: string; reason?: string }>
    }
  }
  const outcome = await provider.authRefreshCallbacks!.refreshBearer({
    attempt: 1,
    previousError: Object.assign(new Error('403'), { status: 403 }),
  })
  expect(outcome.kind).toBe('exhausted')
  expect(outcome.reason).toMatch(/temporarily/)
  expect(outcome.reason).toMatch(/still valid/)
  expect(outcome.reason).not.toMatch(/sign in again/)
})

test('API-key mode keeps the no-refresh default callback', async () => {
  storedAccessToken = undefined
  const { createProvider } = await importProviderModule()

  const provider = createProvider('grok', {
    apiKey: 'xai-real-key',
    model: 'grok-4.5',
  }) as unknown as {
    authRefreshCallbacks?: {
      refreshBearer: (ctx: unknown) => Promise<{ kind: string }>
    }
  }
  const outcome = await provider.authRefreshCallbacks!.refreshBearer({
    attempt: 1,
    previousError: Object.assign(new Error('401'), { status: 401 }),
  })
  expect(outcome.kind).toBe('skipped')
})
