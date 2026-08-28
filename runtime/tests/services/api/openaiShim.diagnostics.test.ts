import { afterEach, expect, mock, test } from 'bun:test'
import { providerConnectionFixture } from './provider-connection-fixture.ts'

const originalFetch = globalThis.fetch

function providerEnvironment(
  baseUrl: string,
  apiKey: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    AGENC_PROVIDER: 'openai-compatible',
    AGENC_MODEL: 'qwen2.5-coder:7b',
    OPENAI_BASE_URL: baseUrl,
    OPENAI_API_KEY: apiKey,
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

test('logs classified transport diagnostics with category and code', async () => {
  const debugSpy = mock(() => {})
  mock.module('src/utils/debug.js', () => ({
    logForDebugging: debugSpy,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { createOpenAiShimClient } = await import(`../../../src/services/api/openaiShim.ts?ts=${nonce}`)

  const transportError = Object.assign(new TypeError('fetch failed'), {
    code: 'ECONNREFUSED',
  })

  globalThis.fetch = mock(async () => {
    throw transportError
  }) as typeof globalThis.fetch

  const client = createOpenAiShimClient({
    connection: providerConnectionFixture({
      provider: 'openai-compatible',
      model: 'qwen2.5-coder:7b',
      environment: providerEnvironment('http://localhost:11434/v1', 'ollama'),
    }),
  }) as {
    beta: {
      messages: {
        create: (params: Record<string, unknown>) => Promise<unknown>
      }
    }
  }

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=connection_refused')

  const transportLog = debugSpy.mock.calls.find(call =>
    typeof call?.[0] === 'string' && call[0].includes('transport failure'),
  )

  expect(transportLog).toBeDefined()
  expect(String(transportLog?.[0])).toContain('category=connection_refused')
  expect(String(transportLog?.[0])).toContain('code=ECONNREFUSED')
  expect(transportLog?.[1]).toEqual({ level: 'warn' })
})

test('logs the bound provider identity instead of inferring it from the URL', async () => {
  const debugSpy = mock(() => {})
  mock.module('src/utils/debug.js', () => ({
    logForDebugging: debugSpy,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { createOpenAiShimClient } = await import(`../../../src/services/api/openaiShim.ts?provider-identity=${nonce}`)

  globalThis.fetch = mock(async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      code: 'ECONNREFUSED',
    })
  }) as typeof globalThis.fetch

  const client = createOpenAiShimClient({
    connection: providerConnectionFixture({
      provider: 'openrouter',
      model: 'x-ai/grok-4.6',
      environment: {
        OPENROUTER_API_KEY: 'openrouter-key',
        OPENROUTER_BASE_URL: 'http://gateway.example/v1',
      },
    }),
  }) as {
    beta: {
      messages: {
        create: (params: Record<string, unknown>) => Promise<unknown>
      }
    }
  }

  await expect(
    client.beta.messages.create({
      model: 'x-ai/grok-4.6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=connection_refused')

  const startLog = debugSpy.mock.calls
    .map(call => call?.[0])
    .find(value =>
      typeof value === 'string' && value.includes('"type":"api_call_start"'),
    )
  expect(startLog).toBeDefined()
  expect(JSON.parse(String(startLog))).toMatchObject({
    type: 'api_call_start',
    provider: 'openrouter',
    model: 'x-ai/grok-4.6',
  })
})

test('redacts credentials in transport diagnostic URL logs', async () => {
  const debugSpy = mock(() => {})
  mock.module('src/utils/debug.js', () => ({
    logForDebugging: debugSpy,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { createOpenAiShimClient } = await import(`../../../src/services/api/openaiShim.ts?ts=${nonce}`)

  const transportError = Object.assign(new TypeError('fetch failed'), {
    code: 'ECONNREFUSED',
  })

  globalThis.fetch = mock(async () => {
    throw transportError
  }) as typeof globalThis.fetch

  const client = createOpenAiShimClient({
    connection: providerConnectionFixture({
      provider: 'openai-compatible',
      model: 'qwen2.5-coder:7b',
      environment: providerEnvironment(
        'http://user:supersecret@localhost:11434/v1',
        'supersecret',
      ),
    }),
  }) as {
    beta: {
      messages: {
        create: (params: Record<string, unknown>) => Promise<unknown>
      }
    }
  }

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=connection_refused')

  const transportLog = debugSpy.mock.calls.find(call =>
    typeof call?.[0] === 'string' && call[0].includes('transport failure'),
  )

  expect(transportLog).toBeDefined()
  const logLine = String(transportLog?.[0])
  expect(logLine).toContain('url=http://redacted:redacted@localhost:11434/v1/chat/completions')
  expect(logLine).not.toContain('user:supersecret')
  expect(logLine).not.toContain('supersecret@')
})
test('logs self-heal localhost fallback with redacted from/to URLs', async () => {
  const debugSpy = mock(() => {})
  mock.module('src/utils/debug.js', () => ({
    logForDebugging: debugSpy,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { createOpenAiShimClient } = await import(`../../../src/services/api/openaiShim.ts?ts=${nonce}`)

  globalThis.fetch = mock(async (input: string | Request) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('localhost')) {
      throw Object.assign(new TypeError('fetch failed'), {
        code: 'ENOTFOUND',
      })
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
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
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as typeof globalThis.fetch

  const client = createOpenAiShimClient({
    connection: providerConnectionFixture({
      provider: 'openai-compatible',
      model: 'qwen2.5-coder:7b',
      environment: providerEnvironment(
        'http://user:supersecret@localhost:11434/v1',
        'supersecret',
      ),
    }),
  }) as {
    beta: {
      messages: {
        create: (params: Record<string, unknown>) => Promise<unknown>
      }
    }
  }

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).resolves.toBeDefined()

  const fallbackLog = debugSpy.mock.calls.find(call =>
    typeof call?.[0] === 'string' &&
    call[0].includes('self-heal retry reason=localhost_resolution_failed'),
  )

  expect(fallbackLog).toBeDefined()
  const logLine = String(fallbackLog?.[0])
  expect(logLine).toContain('from=http://redacted:redacted@localhost:11434/v1/chat/completions')
  expect(logLine).toContain('to=http://redacted:redacted@127.0.0.1:11434/v1/chat/completions')
  expect(logLine).not.toContain('supersecret')
})

test('logs self-heal toolless retry for local tool-call incompatibility', async () => {
  const debugSpy = mock(() => {})
  mock.module('src/utils/debug.js', () => ({
    logForDebugging: debugSpy,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { createOpenAiShimClient } = await import(`../../../src/services/api/openaiShim.ts?ts=${nonce}`)

  let callCount = 0
  globalThis.fetch = mock(async () => {
    callCount += 1
    if (callCount === 1) {
      return new Response('tool_calls are not supported', {
        status: 400,
        headers: {
          'Content-Type': 'text/plain',
        },
      })
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
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
          prompt_tokens: 7,
          completion_tokens: 3,
          total_tokens: 10,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as typeof globalThis.fetch

  const client = createOpenAiShimClient({
    connection: providerConnectionFixture({
      provider: 'openai-compatible',
      model: 'qwen2.5-coder:7b',
      environment: providerEnvironment('http://localhost:11434/v1', 'ollama'),
    }),
  }) as {
    beta: {
      messages: {
        create: (params: Record<string, unknown>) => Promise<unknown>
      }
    }
  }

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'Read',
          description: 'Read file',
          input_schema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
            },
            required: ['filePath'],
          },
        },
      ],
      max_tokens: 64,
      stream: false,
    }),
  ).resolves.toBeDefined()

  const fallbackLog = debugSpy.mock.calls.find(call =>
    typeof call?.[0] === 'string' &&
    call[0].includes('self-heal retry reason=tool_call_incompatible mode=toolless'),
  )

  expect(fallbackLog).toBeDefined()
  expect(fallbackLog?.[1]).toEqual({ level: 'warn' })
})
