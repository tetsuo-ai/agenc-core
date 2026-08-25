import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { runWithStartupProviderSelection } from '../../../src/utils/model/providers.ts'

type FetchType = typeof globalThis.fetch
type GetProviderClient = typeof import('../../../src/services/api/client.ts')['getproviderClient']

type ShimClient = {
  beta: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown>
    }
  }
}

const originalFetch = globalThis.fetch
const originalMacro = (globalThis as Record<string, unknown>).MACRO
let getproviderClient: GetProviderClient
const originalEnv = {
  AGENC_PROVIDER: process.env.AGENC_PROVIDER,
  AGENC_MODEL: process.env.AGENC_MODEL,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
  GEMINI_AUTH_MODE: process.env.GEMINI_AUTH_MODE,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  MISTRAL_BASE_URL: process.env.MISTRAL_BASE_URL,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_BASE_URL: process.env.GITHUB_BASE_URL,
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
  NVIDIA_BASE_URL: process.env.NVIDIA_BASE_URL,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  MINIMAX_BASE_URL: process.env.MINIMAX_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  XAI_API_KEY: process.env.XAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(async () => {
  mock.restore()
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
  process.env.AGENC_PROVIDER = 'gemini'
  process.env.AGENC_MODEL = 'gemini-2.0-flash'
  process.env.GEMINI_API_KEY = 'gemini-test-key'
  process.env.GEMINI_BASE_URL = 'http://127.0.0.1:19080/v1beta'
  process.env.GEMINI_AUTH_MODE = 'api-key'

  delete process.env.GOOGLE_API_KEY
  delete process.env.MISTRAL_API_KEY
  delete process.env.MISTRAL_BASE_URL
  delete process.env.GITHUB_TOKEN
  delete process.env.GITHUB_BASE_URL
  delete process.env.NVIDIA_API_KEY
  delete process.env.NVIDIA_BASE_URL
  delete process.env.MINIMAX_API_KEY
  delete process.env.MINIMAX_BASE_URL
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.XAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_CUSTOM_HEADERS

  const nonce = `${Date.now()}-${Math.random()}`
  const imported = await import(`../../../src/services/api/client.ts?client-test=${nonce}`)
  const getproviderClientImpl = imported.getproviderClient
  getproviderClient = options =>
    runWithStartupProviderSelection(
      {
        provider: process.env.AGENC_PROVIDER ?? 'gemini',
        model: process.env.AGENC_MODEL ?? 'test-model',
        environment: { ...process.env },
      },
      () => getproviderClientImpl(options),
    )
})

afterEach(() => {
  mock.restore()
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  restoreEnv('AGENC_PROVIDER', originalEnv.AGENC_PROVIDER)
  restoreEnv('AGENC_MODEL', originalEnv.AGENC_MODEL)
  restoreEnv('GEMINI_API_KEY', originalEnv.GEMINI_API_KEY)
  restoreEnv('GEMINI_BASE_URL', originalEnv.GEMINI_BASE_URL)
  restoreEnv('GEMINI_AUTH_MODE', originalEnv.GEMINI_AUTH_MODE)
  restoreEnv('GOOGLE_API_KEY', originalEnv.GOOGLE_API_KEY)
  restoreEnv('MISTRAL_API_KEY', originalEnv.MISTRAL_API_KEY)
  restoreEnv('MISTRAL_BASE_URL', originalEnv.MISTRAL_BASE_URL)
  restoreEnv('GITHUB_TOKEN', originalEnv.GITHUB_TOKEN)
  restoreEnv('GITHUB_BASE_URL', originalEnv.GITHUB_BASE_URL)
  restoreEnv('NVIDIA_API_KEY', originalEnv.NVIDIA_API_KEY)
  restoreEnv('NVIDIA_BASE_URL', originalEnv.NVIDIA_BASE_URL)
  restoreEnv('MINIMAX_API_KEY', originalEnv.MINIMAX_API_KEY)
  restoreEnv('MINIMAX_BASE_URL', originalEnv.MINIMAX_BASE_URL)
  restoreEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY)
  restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
  restoreEnv('OPENAI_API_BASE', originalEnv.OPENAI_API_BASE)
  restoreEnv('XAI_API_KEY', originalEnv.XAI_API_KEY)
  restoreEnv('ANTHROPIC_API_KEY', originalEnv.ANTHROPIC_API_KEY)
  restoreEnv('ANTHROPIC_AUTH_TOKEN', originalEnv.ANTHROPIC_AUTH_TOKEN)
  restoreEnv('ANTHROPIC_CUSTOM_HEADERS', originalEnv.ANTHROPIC_CUSTOM_HEADERS)
  globalThis.fetch = originalFetch
})

test('fails closed when Gemini reaches the obsolete compatibility client', async () => {
  let fetchCalled = false
  globalThis.fetch = (async () => {
    fetchCalled = true
    return new Response('{}')
  }) as FetchType

  await expect(
    getproviderClient({
      maxRetries: 0,
      model: 'gemini-2.0-flash',
    }),
  ).rejects.toThrow(
    'Gemini requests must use the canonical native provider transport',
  )
  expect(fetchCalled).toBe(false)
})

test.each([
  {
    name: 'NVIDIA NIM',
    env: {
      AGENC_PROVIDER: 'nvidia-nim',
      NVIDIA_API_KEY: 'nvidia-test-key',
      NVIDIA_BASE_URL: 'http://127.0.0.1:19081/v1',
      AGENC_MODEL: 'nvidia/example-model',
    },
    model: 'nvidia/example-model',
    expectedUrl: 'http://127.0.0.1:19081/v1/chat/completions',
    expectedAuth: 'Bearer nvidia-test-key',
  },
  {
    name: 'MiniMax',
    env: {
      AGENC_PROVIDER: 'minimax',
      MINIMAX_API_KEY: 'minimax-test-key',
      MINIMAX_BASE_URL: 'http://127.0.0.1:19082/v1',
      AGENC_MODEL: 'MiniMax-test-model',
    },
    model: 'MiniMax-test-model',
    expectedUrl: 'http://127.0.0.1:19082/v1/chat/completions',
    expectedAuth: 'Bearer minimax-test-key',
  },
] as const)(
  'routes selected $name requests through the provider-compatible shim',
  async ({ env, model, expectedUrl, expectedAuth }) => {
    let capturedUrl: string | undefined
    let capturedHeaders: Headers | undefined
    let capturedBody: Record<string, unknown> | undefined

    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value
    }

    globalThis.fetch = (async (input, init) => {
      capturedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      capturedHeaders = new Headers(init?.headers)
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

      return new Response(
        JSON.stringify({
          id: 'chatcmpl-compatible',
          model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 3,
            total_tokens: 11,
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as FetchType

    const client = (await getproviderClient({
      maxRetries: 0,
      model,
    })) as unknown as ShimClient

    const response = await client.beta.messages.create({
      model,
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(capturedUrl).toBe(expectedUrl)
    expect(capturedHeaders?.get('authorization')).toBe(expectedAuth)
    expect(capturedBody?.model).toBe(model)
    expect(response).toMatchObject({
      role: 'assistant',
      model,
    })
  },
)

test.each([
  'gpt-5.3-providerCode',
  'gpt-5.3-providerCode-spark',
] as const)(
  'keeps external provider model alias %s on external auth',
  async model => {
    let capturedUrl: string | undefined
    let capturedHeaders: Headers | undefined

    process.env.AGENC_PROVIDER = 'mistral'
    process.env.AGENC_MODEL = model
    process.env.MISTRAL_API_KEY = 'mistral-alias-key'
    process.env.MISTRAL_BASE_URL = 'http://127.0.0.1:19083/v1'

    globalThis.fetch = (async (input, init) => {
      capturedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      capturedHeaders = new Headers(init?.headers)
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-external-alias',
          model,
          choices: [
            {
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as FetchType

    const client = (await getproviderClient({
      maxRetries: 0,
      model,
    })) as unknown as ShimClient
    await client.beta.messages.create({
      model,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })

    expect(capturedUrl).toBe('http://127.0.0.1:19083/v1/chat/completions')
    expect(capturedHeaders?.get('authorization')).toBe(
      'Bearer mistral-alias-key',
    )
  },
)

test.each([
  {
    name: 'openai',
    env: {
      AGENC_PROVIDER: 'openai',
      OPENAI_API_KEY: 'openai-test-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:19084/v1',
      AGENC_MODEL: 'gpt-4o',
    },
    requestModel: 'gpt-4o',
    expectedUrl: 'http://127.0.0.1:19084/v1/chat/completions',
    expectedAuth: 'Bearer openai-test-key',
    expectedModel: 'gpt-4o',
  },
  {
    name: 'GitHub',
    env: {
      AGENC_PROVIDER: 'github',
      GITHUB_TOKEN: 'github-test-token',
      GITHUB_BASE_URL: 'https://models.github.ai/inference',
      AGENC_MODEL: 'openai/gpt-4.1',
    },
    requestModel: 'openai/gpt-4.1',
    expectedUrl: 'https://models.github.ai/inference/chat/completions',
    expectedAuth: 'Bearer github-test-token',
    expectedModel: 'openai/gpt-4.1',
  },
  {
    name: 'Mistral',
    env: {
      AGENC_PROVIDER: 'mistral',
      MISTRAL_API_KEY: 'mistral-provider-key',
      MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
      AGENC_MODEL: 'mistral-medium-latest',
    },
    requestModel: 'mistral-medium-latest',
    expectedUrl: 'https://api.mistral.ai/v1/chat/completions',
    expectedAuth: 'Bearer mistral-provider-key',
    expectedModel: 'mistral-medium-latest',
  },
] as const)(
  'explicit $name selection takes precedence over ambient MiniMax credentials at request routing',
  async ({ env, requestModel, expectedUrl, expectedAuth, expectedModel }) => {
    let capturedUrl: string | undefined
    let capturedHeaders: Headers | undefined
    let capturedBody: Record<string, unknown> | undefined

    process.env.MINIMAX_API_KEY = 'ambient-minimax-key'
    process.env.MINIMAX_BASE_URL = 'http://127.0.0.1:19082/v1'
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value
    }

    globalThis.fetch = (async (input, init) => {
      capturedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      capturedHeaders = new Headers(init?.headers)
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

      return new Response(
        JSON.stringify({
          id: 'chatcmpl-compatible',
          model: expectedModel,
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 3,
            total_tokens: 11,
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as FetchType

    const client = (await getproviderClient({
      maxRetries: 0,
      model: requestModel,
    })) as unknown as ShimClient

    const response = await client.beta.messages.create({
      model: requestModel,
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(capturedUrl).toBe(expectedUrl)
    expect(capturedHeaders?.get('authorization')).toBe(expectedAuth)
    expect(capturedHeaders?.get('authorization')).not.toBe(
      'Bearer ambient-minimax-key',
    )
    expect(capturedBody?.model).toBe(expectedModel)
    expect(response).toMatchObject({
      role: 'assistant',
      model: expectedModel,
    })
  },
)

test('GitHub native provider mode uses provider-specific base URL', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  process.env.AGENC_PROVIDER = 'github'
  process.env.GITHUB_TOKEN = 'github-native-token'
  process.env.GITHUB_BASE_URL = 'http://127.0.0.1:19086'
  process.env.AGENC_MODEL = 'claude-sonnet-4-5'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:19087/v1'

  const fetchOverride: FetchType = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'msg_github_native',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 8,
          output_tokens: 3,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'request-id': 'req_github_native',
        },
      },
    )
  }) as FetchType

  const client = (await getproviderClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-5',
    fetchOverride,
  })) as unknown as ShimClient

  const response = await client.beta.messages.create({
    model: 'claude-sonnet-4-5',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl?.startsWith('http://127.0.0.1:19086/v1/messages')).toBe(
    true,
  )
  expect(capturedUrl).not.toContain('19087')
  expect(capturedHeaders?.get('authorization')).toBe(
    'Bearer github-native-token',
  )
  expect(capturedBody?.model).toBe('claude-sonnet-4-5')
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'claude-sonnet-4-5',
  })
})

test.each([
  {
    name: 'Mistral',
    env: {
      AGENC_PROVIDER: 'mistral',
      MISTRAL_API_KEY: 'mistral-provider-key',
      MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
      AGENC_MODEL: 'mistral-medium-latest',
    },
    expectedUrl: 'https://api.mistral.ai/v1/chat/completions',
    expectedAuth: 'Bearer mistral-provider-key',
    expectedModel: 'mistral-medium-latest',
  },
  {
    name: 'NVIDIA NIM',
    env: {
      AGENC_PROVIDER: 'nvidia-nim',
      NVIDIA_API_KEY: 'nvidia-provider-key',
      NVIDIA_BASE_URL: 'http://127.0.0.1:19081/v1',
      AGENC_MODEL: 'nvidia/provider-model',
    },
    expectedUrl: 'http://127.0.0.1:19081/v1/chat/completions',
    expectedAuth: 'Bearer nvidia-provider-key',
    expectedModel: 'nvidia/provider-model',
  },
  {
    name: 'MiniMax',
    env: {
      AGENC_PROVIDER: 'minimax',
      MINIMAX_API_KEY: 'minimax-provider-key',
      MINIMAX_BASE_URL: 'http://127.0.0.1:19082/v1',
      AGENC_MODEL: 'MiniMax-provider-model',
    },
    expectedUrl: 'http://127.0.0.1:19082/v1/chat/completions',
    expectedAuth: 'Bearer minimax-provider-key',
    expectedModel: 'MiniMax-provider-model',
  },
  {
    name: 'GitHub',
    env: {
      AGENC_PROVIDER: 'github',
      GITHUB_TOKEN: 'github-test-token',
      GITHUB_BASE_URL: 'https://models.github.ai/inference',
      AGENC_MODEL: 'openai/gpt-4.1',
    },
    expectedUrl: 'https://models.github.ai/inference/chat/completions',
    expectedAuth: 'Bearer github-test-token',
    expectedModel: 'openai/gpt-4.1',
  },
] as const)(
  'does not leak stale shared env into selected $name shim requests',
  async ({ env, expectedUrl, expectedAuth, expectedModel }) => {
    let capturedUrl: string | undefined
    let capturedHeaders: Headers | undefined
    let capturedBody: Record<string, unknown> | undefined

    process.env.OPENAI_API_KEY = 'stale-openai-key'
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:19089/v1'
    process.env.OPENAI_API_BASE = 'http://127.0.0.1:19088/v1'
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value
    }

    globalThis.fetch = (async (input, init) => {
      capturedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      capturedHeaders = new Headers(init?.headers)
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

      return new Response(
        JSON.stringify({
          id: 'chatcmpl-compatible',
          model: expectedModel,
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 3,
            total_tokens: 11,
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as FetchType

    const client = (await getproviderClient({
      maxRetries: 0,
      model: expectedModel,
    })) as unknown as ShimClient

    const response = await client.beta.messages.create({
      model: expectedModel,
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(capturedUrl).toBe(expectedUrl)
    expect(capturedHeaders?.get('authorization')).toBe(expectedAuth)
    expect(capturedBody?.model).toBe(expectedModel)
    expect(response).toMatchObject({
      role: 'assistant',
      model: expectedModel,
    })
  },
)

test.each([
  {
    name: 'Mistral',
    env: {
      AGENC_PROVIDER: 'mistral',
      AGENC_MODEL: 'mistral-medium-latest',
    },
    expectedMessage: 'MISTRAL_API_KEY is required for Mistral provider',
  },
  {
    name: 'NVIDIA NIM',
    env: {
      AGENC_PROVIDER: 'nvidia-nim',
      AGENC_MODEL: 'nvidia/provider-model',
    },
    expectedMessage: 'NVIDIA_API_KEY is required for NVIDIA NIM provider',
  },
  {
    name: 'MiniMax',
    env: {
      AGENC_PROVIDER: 'minimax',
      AGENC_MODEL: 'MiniMax-provider-model',
    },
    expectedMessage: 'MINIMAX_API_KEY is required for MiniMax provider',
  },
  {
    name: 'GitHub',
    env: {
      AGENC_PROVIDER: 'github',
      AGENC_MODEL: 'github:copilot',
    },
    expectedMessage: 'GITHUB_TOKEN or GH_TOKEN is required for GitHub provider',
  },
] as const)(
  'fails before fetch when selected $name shim credentials are missing',
  async ({ env, expectedMessage }) => {
    let fetchCalled = false

    process.env.ANTHROPIC_AUTH_TOKEN = 'first-party-token'
    process.env.ANTHROPIC_CUSTOM_HEADERS = [
      'x-api-key: first-party-x-key',
      'api-key: first-party-api-key',
      'x-safe-header: keep-me',
    ].join('\n')
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value
    }

    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }) as FetchType

    await expect(
      getproviderClient({
        maxRetries: 0,
        model: 'stale-request-model',
      }),
    ).rejects.toThrow(expectedMessage)
    expect(fetchCalled).toBe(false)
  },
)

test('strips first-party auth headers before hosted provider shim requests', async () => {
  let capturedHeaders: Headers | undefined

  process.env.AGENC_PROVIDER = 'mistral'
  process.env.MISTRAL_API_KEY = 'mistral-provider-key'
  process.env.MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'
  process.env.AGENC_MODEL = 'mistral-medium-latest'
  process.env.ANTHROPIC_AUTH_TOKEN = 'first-party-token'
  process.env.ANTHROPIC_CUSTOM_HEADERS = [
    'Authorization: stale-first-party-bearer',
    'x-api-key: first-party-x-key',
    'api-key: first-party-api-key',
    'x-goog-api-key: stale-google-key',
    'x-goog-user-project: stale-google-project',
    'x-safe-header: keep-me',
  ].join('\n')

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-mistral',
        model: 'mistral-medium-latest',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getproviderClient({
    maxRetries: 0,
    model: 'mistral-medium-latest',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'mistral-medium-latest',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('authorization')).toBe('Bearer mistral-provider-key')
  expect(capturedHeaders?.get('x-api-key')).toBeNull()
  expect(capturedHeaders?.get('api-key')).toBeNull()
  expect(capturedHeaders?.get('x-goog-api-key')).toBeNull()
  expect(capturedHeaders?.get('x-goog-user-project')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
})

test('strips provider-specific custom headers before sending provider-compatible shim requests', async () => {
  let capturedHeaders: Headers | undefined

  process.env.AGENC_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'openai-test-key'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:19083/v1'
  process.env.AGENC_MODEL = 'gpt-4o'
  process.env.ANTHROPIC_CUSTOM_HEADERS = [
    'anthropic-version: 2023-06-01',
    'anthropic-beta: prompt-caching-2024-07-31',
    'x-anthropic-additional-protection: true',
    'x-agenc-remote-session-id: remote-123',
    'x-app: cli',
    'x-safe-header: keep-me',
  ].join('\n')

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-openai',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getproviderClient({
    maxRetries: 0,
    model: 'gpt-4o',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('anthropic-version')).toBeNull()
  expect(capturedHeaders?.get('anthropic-beta')).toBeNull()
  expect(capturedHeaders?.get('x-anthropic-additional-protection')).toBeNull()
  expect(capturedHeaders?.get('x-agenc-remote-session-id')).toBeNull()
  expect(capturedHeaders?.get('x-app')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer openai-test-key')
})
