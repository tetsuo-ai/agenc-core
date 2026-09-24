import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resolveHomeContext } from '../../src/config/home.js'
import { SandboxExecutionBroker } from '../../src/sandbox/execution-broker.js'

/**
 * Factory wiring for Sign in with X / xAI OAuth: with no API key, the grok
 * provider falls back to the stored subscription bearer, installs the I-14
 * auth-refresh callbacks, and refuses to ship the bearer to non-xAI hosts.
 */

const credentialsModulePath = '../../src/utils/xaiOauthCredentials.js'
const CREDENTIAL_HOME = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-grok-oauth-factory' },
  { platformHome: '/tmp' },
)

let storedAccessToken: string | undefined
let previousAccessTokens = new Set<string>()
let requiresRelogin = true
const forceRefreshMock = vi.fn()

async function importProviderModule() {
  vi.resetModules()
  vi.doMock(credentialsModulePath, () => ({
    readXaiOauthAccessToken: () => storedAccessToken,
    isXaiOauthBearer: (_home: unknown, key: string | undefined) =>
      key !== undefined && (key === storedAccessToken || previousAccessTokens.has(key)),
    forceRefreshXaiOauthCredentials: forceRefreshMock,
    xaiOauthRequiresRelogin: () => requiresRelogin,
  }))
  const [providerModule, optionsModule] = await Promise.all([
    import('../../src/llm/provider.ts'),
    import('../../src/llm/provider-options.ts'),
  ])
  return {
    ...providerModule,
    resolveProviderFactoryOptions: optionsModule.resolveProviderFactoryOptions,
    /** The factory itself, without the option resolver's OAuth substitution. */
    createProviderRaw: providerModule.createProvider,
    createProvider: (
      provider: 'grok',
      requested: Parameters<typeof providerModule.createProvider>[1],
    ) => providerModule.createProvider(
      provider,
      optionsModule.resolveProviderFactoryOptions(provider, requested, {
        AGENC_HOME: CREDENTIAL_HOME.path,
      }),
    ),
  }
}

beforeEach(() => {
  storedAccessToken = undefined
  previousAccessTokens = new Set()
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

  const provider = createProvider('grok', {
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
  })
  expect(provider.name).toBe('grok')
  expect((provider as unknown as { config: { apiKey: string; baseURL: string } }).config)
    .toMatchObject({ apiKey: 'oauth-bearer-1', baseURL: 'https://api.x.ai/v1' })
})

test('grok without apiKey and without stored OAuth still requires a key', async () => {
  storedAccessToken = undefined
  const { createProvider } = await importProviderModule()

  expect(() => createProvider('grok', {
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
  })).toThrow(
    /requires apiKey/,
  )
})

test('/grok-login OAuth wins over an explicit env-style apiKey', async () => {
  // Product rule: signing in with X means subscription access — leftover
  // XAI_API_KEY / factory apiKey must not shadow the OAuth bearer.
  storedAccessToken = 'oauth-bearer-1'
  const { createProvider } = await importProviderModule()

  const custom = createProvider('grok', {
    apiKey: 'xai-real-key',
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
    baseURL: 'https://gateway.example.test/v1',
    extra: { authMode: 'api_key' },
  }) as unknown as { config: { apiKey: string; baseURL: string } }
  expect(custom.config.apiKey).toBe('xai-real-key')
  expect(custom.config.baseURL).toBe('https://gateway.example.test/v1')

  const provider = createProvider('grok', {
    apiKey: 'xai-real-key',
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
  })
  expect(provider.name).toBe('grok')
})

test('OAuth bearer is refused for non-xAI base URLs', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProvider } = await importProviderModule()

  expect(() =>
    createProvider('grok', {
      model: 'grok-4.5',
      credentialHome: CREDENTIAL_HOME,
      baseURL: 'https://attacker.example/v1',
    }),
  ).toThrow(/xAI sign-in credentials.*custom Grok base URL/)
})

test('OAuth bearer is refused for the grok.com CLI proxy base URL', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProvider } = await importProviderModule()

  expect(() => createProvider('grok', {
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
    baseURL: 'https://cli-chat-proxy.grok.com/v1',
  })).toThrow(/xAI sign-in credentials.*custom Grok base URL/)
})

test('OAuth bearer is refused for a lookalike xAI path', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProviderRaw } = await importProviderModule()
  expect(() => createProviderRaw('grok', {
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
    baseURL: 'https://api.x.ai/proxy/v1',
  })).toThrow(/refusing to send the xAI OAuth bearer/)
})

test('API-key mode is exempt from the OAuth base URL pin', async () => {
  storedAccessToken = undefined
  const { createProvider } = await importProviderModule()

  const provider = createProvider('grok', {
    apiKey: 'xai-real-key',
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
    baseURL: 'https://my-gateway.example/v1',
  })
  expect(provider.name).toBe('grok')
})

test('custom gateway requests carry the API key instead of the stored sign-in token', async () => {
  storedAccessToken = 'fake-xai-sign-in-token'
  const { createProvider } = await importProviderModule()
  const { runWithStartupProviderSelection } = await import('../../src/utils/model/providers.js')
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response('{}', { status: 400 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const provider = createProvider('grok', {
      apiKey: 'fake-xai-api-key',
      model: 'grok-4.5',
      credentialHome: CREDENTIAL_HOME,
      baseURL: 'https://gateway.example.test/v1',
      extra: { authMode: 'api_key' },
    })
    const error = await runWithStartupProviderSelection(
      { provider: 'grok', model: 'grok-4.5', environment: {} },
      () => provider.chat([{ role: 'user', content: 'hi' }]).catch((failure: unknown) => failure),
    )
    expect(fetchMock.mock.calls.length, String(error)).toBeGreaterThan(0)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toContain('gateway.example.test')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-xai-api-key')
      expect(new Headers(init?.headers).get('authorization')).not.toContain('fake-xai-sign-in-token')
    }
  } finally {
    vi.unstubAllGlobals()
  }
})

test('composer never passes a stored sign-in token as its CLI API key', async () => {
  storedAccessToken = 'fake-xai-sign-in-token'
  const { createProviderRaw } = await importProviderModule()
  expect(() => createProviderRaw('grok', {
    apiKey: 'fake-xai-sign-in-token',
    model: 'grok-composer-2.5-fast',
    credentialHome: CREDENTIAL_HOME,
    extra: { grokAcp: { environment: {} } },
  })).toThrow(/refusing to pass the xAI sign-in token/)
})

test('composer rejects a rotated sign-in token selected from the environment for a custom URL', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProviderRaw, resolveProviderFactoryOptions } = await importProviderModule()
  previousAccessTokens.add(storedAccessToken)
  storedAccessToken = 'oauth-bearer-2'
  const options = resolveProviderFactoryOptions('grok', {
    model: 'grok-composer-2.5-fast',
    credentialHome: CREDENTIAL_HOME,
    extra: { grokAcp: { environment: {
      XAI_API_KEY: 'oauth-bearer-1',
      XAI_BASE_URL: 'https://gateway.example.test/v1',
    } } },
  }, { XAI_API_KEY: 'oauth-bearer-1', XAI_BASE_URL: 'https://gateway.example.test/v1' })
  expect(options.apiKey).toBe('oauth-bearer-1')
  expect(() => createProviderRaw('grok', options)).toThrow(/refusing to pass the xAI sign-in token/)
})

test('API-key mode cannot re-label the stored sign-in token as a gateway key', async () => {
  storedAccessToken = 'fake-xai-sign-in-token'
  const { createProviderRaw } = await importProviderModule()
  expect(() => createProviderRaw('grok', {
    apiKey: 'fake-xai-sign-in-token',
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
    baseURL: 'https://gateway.example.test/v1',
    extra: { authMode: 'api_key' },
  })).toThrow(/refusing to use the stored xAI sign-in token as an API key/)
})

test('OAuth mode installs a working 401 refresh callback', async () => {
  storedAccessToken = 'oauth-bearer-1'
  forceRefreshMock.mockResolvedValue({ accessToken: 'oauth-bearer-2' })
  const { createProvider } = await importProviderModule()

  const provider = createProvider('grok', {
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
  }) as unknown as {
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

  const provider = createProvider('grok', {
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
  }) as unknown as {
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

  const provider = createProvider('grok', {
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
  }) as unknown as {
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
    credentialHome: CREDENTIAL_HOME,
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

test('a stale bearer snapshot passed as apiKey does not demote the raw factory to API-key mode', async () => {
  // Soak F76: the verified-change reviewer's provider was re-created from
  // the parent session's recorded factory options, which held the bearer
  // resolved at run start. The stored grant had been refreshed since, so
  // the snapshot matched nothing and the raw factory picked API-key mode:
  // no refresh callbacks, no pre-flight, and xAI answered 403.
  storedAccessToken = 'oauth-bearer-2'
  const { createProviderRaw } = await importProviderModule()

  const provider = createProviderRaw('grok', {
    apiKey: 'oauth-bearer-1',
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
  })
  expect((provider as unknown as { config: { apiKey: string } }).config.apiKey).toBe(
    'oauth-bearer-2',
  )
  // OAuth mode is active: the bearer is refused for a non-xAI host.
  expect(() =>
    createProviderRaw('grok', {
      apiKey: 'oauth-bearer-1',
      model: 'grok-4.5',
      credentialHome: CREDENTIAL_HOME,
      baseURL: 'https://attacker.example/v1',
    }),
  ).toThrow(/refusing to send the xAI OAuth bearer/)
})

test('a provider re-created from recorded factory options after a refresh carries the current grant', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProviderRaw, readProviderFactoryOptions } = await importProviderModule()
  const first = createProviderRaw('grok', {
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
  })

  storedAccessToken = 'oauth-bearer-2'
  const second = createProviderRaw('grok', {
    ...readProviderFactoryOptions(first),
    model: 'grok-4.5',
  })
  expect((second as unknown as { config: { apiKey: string } }).config.apiKey).toBe(
    'oauth-bearer-2',
  )
  expect(
    (second as unknown as { oauthCallbacksInstalled: boolean }).oauthCallbacksInstalled,
  ).toBe(true)
})

test('a stale OAuth snapshot cannot become a gateway API key', async () => {
  storedAccessToken = 'fake-xai-sign-in-token-1'
  const { createProviderRaw, readProviderFactoryOptions, resolveProviderFactoryOptions } =
    await importProviderModule()
  const first = createProviderRaw('grok', {
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
  })
  previousAccessTokens.add(storedAccessToken)
  storedAccessToken = 'fake-xai-sign-in-token-2'
  expect(() => resolveProviderFactoryOptions('grok', {
    ...readProviderFactoryOptions(first),
    baseURL: 'https://gateway.example.test/v1',
  }, {})).toThrow(/xAI sign-in credentials.*custom Grok base URL/)
  expect(() => resolveProviderFactoryOptions('grok', {
    apiKey: 'fake-xai-sign-in-token-1',
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
    baseURL: 'https://gateway.example.test/v1',
  }, {})).toThrow(/xAI sign-in credentials.*custom Grok base URL/)
})

test('a session fork preserves configuration and refreshes only its own OAuth client', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProviderRaw, readProviderFactoryOptions } = await importProviderModule()
  const parent = createProviderRaw('grok', {
    model: 'grok-4.5',
    credentialHome: CREDENTIAL_HOME,
    baseURL: 'https://api.x.ai/v1',
    timeoutMs: 12000,
    tools: [{
      type: 'function',
      function: {
        name: 'inspect_file',
        description: 'Inspect a file',
        parameters: { type: 'object', properties: {} },
      },
    }],
    extra: {
      authMode: 'oauth',
      incrementalContinuation: true,
      parallelToolCalls: false,
      temperature: 0.2,
    },
  })
  storedAccessToken = 'oauth-bearer-2'
  const child = parent.forkForSession!({
    cwd: process.cwd(),
    sandboxExecutionBroker: new SandboxExecutionBroker({
      mode: 'danger_full_access',
      cwd: process.cwd(),
    }),
  })
  type OAuthProviderState = {
    client: { apiKey: string }
    config: { apiKey: string }
    authRefreshCallbacks: {
      refreshBearer: (ctx: unknown) => Promise<{ kind: string; bearer?: string }>
    }
  }
  const parentState = parent as unknown as OAuthProviderState
  const childState = child as unknown as OAuthProviderState
  const parentClient = { apiKey: 'oauth-bearer-1' }
  const childClient = { apiKey: 'oauth-bearer-2' }
  parentState.client = parentClient
  childState.client = childClient
  try {
    expect(child).not.toBe(parent)
    expect(readProviderFactoryOptions(child)).toMatchObject({
      credentialHome: CREDENTIAL_HOME,
      model: 'grok-4.5',
      baseURL: 'https://api.x.ai/v1',
      timeoutMs: 12000,
      tools: [{ function: { name: 'inspect_file' } }],
      extra: {
        authMode: 'oauth',
        incrementalContinuation: true,
        parallelToolCalls: false,
        temperature: 0.2,
      },
    })
    expect(readProviderFactoryOptions(child)).toEqual({
      ...readProviderFactoryOptions(parent),
      apiKey: 'oauth-bearer-2',
    })
    expect(forceRefreshMock).not.toHaveBeenCalled()

    forceRefreshMock.mockResolvedValue({ accessToken: 'oauth-bearer-3' })
    const outcome = await childState.authRefreshCallbacks.refreshBearer({
      attempt: 1,
      previousError: Object.assign(new Error('401'), { status: 401 }),
    })

    expect(outcome).toEqual({ kind: 'refreshed', bearer: 'oauth-bearer-3' })
    expect(forceRefreshMock).toHaveBeenCalledExactlyOnceWith(CREDENTIAL_HOME, 'oauth-bearer-2')
    expect(childClient.apiKey).toBe('oauth-bearer-3')
    expect(childState.config.apiKey).toBe('oauth-bearer-3')
    expect(parentClient.apiKey).toBe('oauth-bearer-1')
    expect(parentState.config.apiKey).toBe('oauth-bearer-1')
  } finally {
    await child.dispose?.()
    await parent.dispose?.()
  }
})

test('explicit API-key selection survives the raw factory and recorded-option recreation', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProviderRaw, readProviderFactoryOptions, resolveProviderFactoryOptions } = await importProviderModule()
  const options = resolveProviderFactoryOptions('grok', {
    model: 'grok-4.5', credentialHome: CREDENTIAL_HOME,
    baseURL: 'https://api-gateway.example/v1',
  }, { GROK_AUTH_MODE: 'api-key', XAI_API_KEY: 'explicit-api-key' })
  const first = createProviderRaw('grok', options)
  storedAccessToken = 'oauth-bearer-2'
  const second = createProviderRaw('grok', readProviderFactoryOptions(first)!)
  for (const provider of [first, second]) {
    expect((provider as unknown as { config: { apiKey: string } }).config.apiKey).toBe('explicit-api-key')
    expect((provider as unknown as { oauthCallbacksInstalled: boolean }).oauthCallbacksInstalled).toBe(false)
  }
})

test('explicit API-key selection without a key cannot fall back to a saved OAuth grant', async () => {
  storedAccessToken = 'oauth-bearer-1'
  const { createProviderRaw, resolveProviderFactoryOptions } = await importProviderModule()
  const options = resolveProviderFactoryOptions('grok', {
    model: 'grok-4.5', credentialHome: CREDENTIAL_HOME,
  }, { GROK_AUTH_MODE: 'api-key' })
  expect(() => createProviderRaw('grok', options)).toThrow(/requires apiKey/)
})
