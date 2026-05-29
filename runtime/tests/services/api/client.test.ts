import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

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
  AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
  AGENC_USE_GEMINI: process.env.AGENC_USE_GEMINI,
  AGENC_USE_MISTRAL: process.env.AGENC_USE_MISTRAL,
  AGENC_USE_GITHUB: process.env.AGENC_USE_GITHUB,
  AGENC_USE_MINIMAX: process.env.AGENC_USE_MINIMAX,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
  GEMINI_AUTH_MODE: process.env.GEMINI_AUTH_MODE,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  MISTRAL_BASE_URL: process.env.MISTRAL_BASE_URL,
  MISTRAL_MODEL: process.env.MISTRAL_MODEL,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_BASE_URL: process.env.GITHUB_BASE_URL,
  GITHUB_MODEL: process.env.GITHUB_MODEL,
  NVIDIA_NIM: process.env.NVIDIA_NIM,
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
  NVIDIA_BASE_URL: process.env.NVIDIA_BASE_URL,
  NVIDIA_MODEL: process.env.NVIDIA_MODEL,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  MINIMAX_BASE_URL: process.env.MINIMAX_BASE_URL,
  MINIMAX_MODEL: process.env.MINIMAX_MODEL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
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
  process.env.AGENC_USE_GEMINI = '1'
  process.env.GEMINI_API_KEY = 'gemini-test-key'
  process.env.GEMINI_MODEL = 'gemini-2.0-flash'
  process.env.GEMINI_BASE_URL = 'http://127.0.0.1:19080/v1beta/openai'
  process.env.GEMINI_AUTH_MODE = 'api-key'

  delete process.env.AGENC_USE_OPENAI
  delete process.env.AGENC_USE_MISTRAL
  delete process.env.AGENC_USE_GITHUB
  delete process.env.AGENC_USE_MINIMAX
  delete process.env.GOOGLE_API_KEY
  delete process.env.MISTRAL_API_KEY
  delete process.env.MISTRAL_BASE_URL
  delete process.env.MISTRAL_MODEL
  delete process.env.GITHUB_TOKEN
  delete process.env.GITHUB_BASE_URL
  delete process.env.GITHUB_MODEL
  delete process.env.NVIDIA_NIM
  delete process.env.NVIDIA_API_KEY
  delete process.env.NVIDIA_BASE_URL
  delete process.env.NVIDIA_MODEL
  delete process.env.MINIMAX_API_KEY
  delete process.env.MINIMAX_BASE_URL
  delete process.env.MINIMAX_MODEL
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_MODEL
  delete process.env.XAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_CUSTOM_HEADERS

  const nonce = `${Date.now()}-${Math.random()}`
  ;({ getproviderClient } = await import(`../../../src/services/api/client.ts?client-test=${nonce}`))
})

afterEach(() => {
  mock.restore()
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  restoreEnv('AGENC_USE_OPENAI', originalEnv.AGENC_USE_OPENAI)
  restoreEnv('AGENC_USE_GEMINI', originalEnv.AGENC_USE_GEMINI)
  restoreEnv('AGENC_USE_MISTRAL', originalEnv.AGENC_USE_MISTRAL)
  restoreEnv('AGENC_USE_GITHUB', originalEnv.AGENC_USE_GITHUB)
  restoreEnv('AGENC_USE_MINIMAX', originalEnv.AGENC_USE_MINIMAX)
  restoreEnv('GEMINI_API_KEY', originalEnv.GEMINI_API_KEY)
  restoreEnv('GEMINI_MODEL', originalEnv.GEMINI_MODEL)
  restoreEnv('GEMINI_BASE_URL', originalEnv.GEMINI_BASE_URL)
  restoreEnv('GEMINI_AUTH_MODE', originalEnv.GEMINI_AUTH_MODE)
  restoreEnv('GOOGLE_API_KEY', originalEnv.GOOGLE_API_KEY)
  restoreEnv('MISTRAL_API_KEY', originalEnv.MISTRAL_API_KEY)
  restoreEnv('MISTRAL_BASE_URL', originalEnv.MISTRAL_BASE_URL)
  restoreEnv('MISTRAL_MODEL', originalEnv.MISTRAL_MODEL)
  restoreEnv('GITHUB_TOKEN', originalEnv.GITHUB_TOKEN)
  restoreEnv('GITHUB_BASE_URL', originalEnv.GITHUB_BASE_URL)
  restoreEnv('GITHUB_MODEL', originalEnv.GITHUB_MODEL)
  restoreEnv('NVIDIA_NIM', originalEnv.NVIDIA_NIM)
  restoreEnv('NVIDIA_API_KEY', originalEnv.NVIDIA_API_KEY)
  restoreEnv('NVIDIA_BASE_URL', originalEnv.NVIDIA_BASE_URL)
  restoreEnv('NVIDIA_MODEL', originalEnv.NVIDIA_MODEL)
  restoreEnv('MINIMAX_API_KEY', originalEnv.MINIMAX_API_KEY)
  restoreEnv('MINIMAX_BASE_URL', originalEnv.MINIMAX_BASE_URL)
  restoreEnv('MINIMAX_MODEL', originalEnv.MINIMAX_MODEL)
  restoreEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY)
  restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
  restoreEnv('OPENAI_API_BASE', originalEnv.OPENAI_API_BASE)
  restoreEnv('OPENAI_MODEL', originalEnv.OPENAI_MODEL)
  restoreEnv('XAI_API_KEY', originalEnv.XAI_API_KEY)
  restoreEnv('ANTHROPIC_API_KEY', originalEnv.ANTHROPIC_API_KEY)
  restoreEnv('ANTHROPIC_AUTH_TOKEN', originalEnv.ANTHROPIC_AUTH_TOKEN)
  restoreEnv('ANTHROPIC_CUSTOM_HEADERS', originalEnv.ANTHROPIC_CUSTOM_HEADERS)
  globalThis.fetch = originalFetch
})

test('routes Gemini provider requests through the provider-compatible shim', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

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
        id: 'chatcmpl-gemini',
        model: 'gemini-2.0-flash',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'gemini ok',
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
    model: 'gemini-2.0-flash',
  })) as unknown as ShimClient

  const response = await client.beta.messages.create({
    model: 'gemini-2.0-flash',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('http://127.0.0.1:19080/v1beta/openai/chat/completions')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer gemini-test-key')
  expect(capturedBody?.model).toBe('gemini-2.0-flash')
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'gemini-2.0-flash',
  })
})

test.each([
  {
    name: 'NVIDIA NIM',
    env: {
      NVIDIA_NIM: '1',
      NVIDIA_API_KEY: 'nvidia-test-key',
      NVIDIA_BASE_URL: 'http://127.0.0.1:19081/v1',
      NVIDIA_MODEL: 'nvidia/example-model',
    },
    model: 'nvidia/example-model',
    expectedUrl: 'http://127.0.0.1:19081/v1/chat/completions',
    expectedAuth: 'Bearer nvidia-test-key',
  },
  {
    name: 'MiniMax',
    env: {
      MINIMAX_API_KEY: 'minimax-test-key',
      MINIMAX_BASE_URL: 'http://127.0.0.1:19082/v1',
      MINIMAX_MODEL: 'MiniMax-test-model',
    },
    model: 'MiniMax-test-model',
    expectedUrl: 'http://127.0.0.1:19082/v1/chat/completions',
    expectedAuth: 'Bearer minimax-test-key',
  },
] as const)(
  'routes env-only $name requests through the provider-compatible shim',
  async ({ env, model, expectedUrl, expectedAuth }) => {
    let capturedUrl: string | undefined
    let capturedHeaders: Headers | undefined
    let capturedBody: Record<string, unknown> | undefined

    delete process.env.AGENC_USE_GEMINI
    delete process.env.AGENC_USE_OPENAI
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
  {
    name: 'openai',
    env: {
      AGENC_USE_OPENAI: '1',
      OPENAI_API_KEY: 'openai-test-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:19084/v1',
      OPENAI_MODEL: 'gpt-4o',
    },
    requestModel: 'gpt-4o',
    expectedUrl: 'http://127.0.0.1:19084/v1/chat/completions',
    expectedAuth: 'Bearer openai-test-key',
    expectedModel: 'gpt-4o',
  },
  {
    name: 'GitHub',
    env: {
      AGENC_USE_GITHUB: '1',
      GITHUB_TOKEN: 'github-test-token',
      GITHUB_BASE_URL: 'https://models.github.ai/inference',
      GITHUB_MODEL: 'openai/gpt-4.1',
    },
    requestModel: 'stale-request-model',
    expectedUrl: 'https://models.github.ai/inference/chat/completions',
    expectedAuth: 'Bearer github-test-token',
    expectedModel: 'openai/gpt-4.1',
  },
  {
    name: 'Mistral',
    env: {
      AGENC_USE_MISTRAL: '1',
      MISTRAL_API_KEY: 'mistral-provider-key',
      MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
      MISTRAL_MODEL: 'devstral-latest',
    },
    requestModel: 'stale-request-model',
    expectedUrl: 'https://api.mistral.ai/v1/chat/completions',
    expectedAuth: 'Bearer mistral-provider-key',
    expectedModel: 'devstral-latest',
  },
] as const)(
  'explicit $name selection takes precedence over ambient MiniMax credentials at request routing',
  async ({ env, requestModel, expectedUrl, expectedAuth, expectedModel }) => {
    let capturedUrl: string | undefined
    let capturedHeaders: Headers | undefined
    let capturedBody: Record<string, unknown> | undefined

    delete process.env.AGENC_USE_GEMINI
    process.env.MINIMAX_API_KEY = 'ambient-minimax-key'
    process.env.MINIMAX_BASE_URL = 'http://127.0.0.1:19082/v1'
    process.env.MINIMAX_MODEL = 'MiniMax-ambient-model'
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

  delete process.env.AGENC_USE_GEMINI
  process.env.AGENC_USE_GITHUB = '1'
  process.env.GITHUB_TOKEN = 'github-native-token'
  process.env.GITHUB_BASE_URL = 'http://127.0.0.1:19086'
  process.env.GITHUB_MODEL = 'claude-sonnet-4-5'
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
      AGENC_USE_MISTRAL: '1',
      MISTRAL_API_KEY: 'mistral-provider-key',
      MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
      MISTRAL_MODEL: 'devstral-latest',
    },
    expectedUrl: 'https://api.mistral.ai/v1/chat/completions',
    expectedAuth: 'Bearer mistral-provider-key',
    expectedModel: 'devstral-latest',
  },
  {
    name: 'NVIDIA NIM',
    env: {
      NVIDIA_NIM: '1',
      NVIDIA_API_KEY: 'nvidia-provider-key',
      NVIDIA_BASE_URL: 'http://127.0.0.1:19081/v1',
      NVIDIA_MODEL: 'nvidia/provider-model',
    },
    expectedUrl: 'http://127.0.0.1:19081/v1/chat/completions',
    expectedAuth: 'Bearer nvidia-provider-key',
    expectedModel: 'nvidia/provider-model',
  },
  {
    name: 'MiniMax',
    env: {
      AGENC_USE_MINIMAX: '1',
      MINIMAX_API_KEY: 'minimax-provider-key',
      MINIMAX_BASE_URL: 'http://127.0.0.1:19082/v1',
      MINIMAX_MODEL: 'MiniMax-provider-model',
    },
    expectedUrl: 'http://127.0.0.1:19082/v1/chat/completions',
    expectedAuth: 'Bearer minimax-provider-key',
    expectedModel: 'MiniMax-provider-model',
  },
  {
    name: 'GitHub',
    env: {
      AGENC_USE_GITHUB: '1',
      GITHUB_TOKEN: 'github-test-token',
      GITHUB_BASE_URL: 'https://models.github.ai/inference',
      GITHUB_MODEL: 'openai/gpt-4.1',
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

    delete process.env.AGENC_USE_GEMINI
    delete process.env.AGENC_USE_OPENAI
    process.env.OPENAI_API_KEY = 'stale-openai-key'
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:19089/v1'
    process.env.OPENAI_API_BASE = 'http://127.0.0.1:19088/v1'
    process.env.OPENAI_MODEL = 'stale-openai-model'
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
      model: 'stale-request-model',
    })) as unknown as ShimClient

    const response = await client.beta.messages.create({
      model: 'stale-request-model',
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
      AGENC_USE_MISTRAL: '1',
      MISTRAL_MODEL: 'devstral-latest',
    },
    expectedMessage: 'MISTRAL_API_KEY is required for Mistral provider',
  },
  {
    name: 'NVIDIA NIM',
    env: {
      NVIDIA_NIM: '1',
      NVIDIA_MODEL: 'nvidia/provider-model',
    },
    expectedMessage: 'NVIDIA_API_KEY is required for NVIDIA NIM provider',
  },
  {
    name: 'MiniMax',
    env: {
      AGENC_USE_MINIMAX: '1',
      MINIMAX_MODEL: 'MiniMax-provider-model',
    },
    expectedMessage: 'MINIMAX_API_KEY is required for MiniMax provider',
  },
  {
    name: 'GitHub',
    env: {
      AGENC_USE_GITHUB: '1',
      GITHUB_MODEL: 'github:copilot',
    },
    expectedMessage: 'GITHUB_TOKEN or GH_TOKEN is required for GitHub provider',
  },
] as const)(
  'fails before fetch when selected $name shim credentials are missing',
  async ({ env, expectedMessage }) => {
    let fetchCalled = false

    delete process.env.AGENC_USE_GEMINI
    delete process.env.AGENC_USE_OPENAI
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

  delete process.env.AGENC_USE_GEMINI
  process.env.AGENC_USE_MISTRAL = '1'
  process.env.MISTRAL_API_KEY = 'mistral-provider-key'
  process.env.MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'
  process.env.MISTRAL_MODEL = 'devstral-latest'
  process.env.ANTHROPIC_AUTH_TOKEN = 'first-party-token'
  process.env.ANTHROPIC_CUSTOM_HEADERS = [
    'x-api-key: first-party-x-key',
    'api-key: first-party-api-key',
    'x-safe-header: keep-me',
  ].join('\n')

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-mistral',
        model: 'devstral-latest',
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
    model: 'devstral-latest',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'devstral-latest',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('authorization')).toBe('Bearer mistral-provider-key')
  expect(capturedHeaders?.get('x-api-key')).toBeNull()
  expect(capturedHeaders?.get('api-key')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
})

test('strips provider-specific custom headers before sending provider-compatible shim requests', async () => {
  let capturedHeaders: Headers | undefined

  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'openai-test-key'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:19083/v1'
  process.env.OPENAI_MODEL = 'gpt-4o'
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

test('strips provider-specific custom headers on providerOverride shim requests too', async () => {
  let capturedHeaders: Headers | undefined

  process.env.ANTHROPIC_CUSTOM_HEADERS = [
    'anthropic-version: 2023-06-01',
    'anthropic-beta: prompt-caching-2024-07-31',
    'x-agenc-remote-session-id: remote-123',
    'x-safe-header: keep-me',
  ].join('\n')

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-provider-override',
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
    providerOverride: {
      model: 'gpt-4o',
      baseURL: 'http://127.0.0.1:19085/v1',
      apiKey: 'provider-test-key',
    },
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'unused',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('anthropic-version')).toBeNull()
  expect(capturedHeaders?.get('anthropic-beta')).toBeNull()
  expect(capturedHeaders?.get('x-agenc-remote-session-id')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer provider-test-key')
})
