import { describe, expect, test } from 'bun:test'
import { runWithCurrentRuntimeSession } from '../../../src/session/current-session.ts'
import type { Session } from '../../../src/session/session.ts'
import { getproviderClient } from '../../../src/services/api/client.ts'
import { providerBindingFixture } from './provider-connection-fixture.ts'

;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: 'test-version' }

type ShimClient = {
  beta: {
    messages: {
      create(params: Record<string, unknown>): Promise<unknown>
    }
  }
}

function successfulResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-bound',
      choices: [
        {
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

async function exercise(client: unknown): Promise<void> {
  await (client as ShimClient).beta.messages.create({
    model: 'stale-call-model',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })
}

describe('bound provider client authority', () => {
  test('uses an explicit prepared binding after same-provider environment drift', async () => {
    let capturedUrl = ''
    let capturedHeaders: Headers | undefined
    const binding = providerBindingFixture({
      provider: 'mistral',
      model: 'mistral-medium-latest',
      environment: {
        MISTRAL_API_KEY: 'prepared-mistral-key',
        MISTRAL_BASE_URL: 'https://prepared.mistral.example/v1',
      },
      factoryOptions: {
        extra: {
          fetchImpl: (async (input, init) => {
            capturedUrl = String(input)
            capturedHeaders = new Headers(init?.headers)
            return successfulResponse()
          }) as typeof fetch,
        },
      },
    })

    const client = await getproviderClient({
      maxRetries: 0,
      providerBinding: binding,
      providerEnvironment: {
        MISTRAL_API_KEY: 'stale-mistral-key',
        MISTRAL_BASE_URL: 'https://stale.mistral.example/v1',
        OPENAI_AUTH_HEADER: 'Authorization',
        OPENAI_AUTH_HEADER_VALUE: 'stale-openai-token',
        OPENAI_API_FORMAT: 'responses',
      },
    })
    await exercise(client)

    expect(capturedUrl).toBe(
      'https://prepared.mistral.example/v1/chat/completions',
    )
    expect(capturedHeaders?.get('authorization')).toBe(
      'Bearer prepared-mistral-key',
    )
  })

  test('uses the AsyncLocalStorage session binding when no binding is passed', async () => {
    let capturedAuthorization: string | null = null
    const environment = Object.freeze({
      MISTRAL_API_KEY: 'session-mistral-key',
      MISTRAL_BASE_URL: 'https://session.mistral.example/v1',
    })
    const binding = providerBindingFixture({
      provider: 'mistral',
      model: 'mistral-medium-latest',
      environment,
      factoryOptions: {
        extra: {
          fetchImpl: (async (_input, init) => {
            capturedAuthorization = new Headers(init?.headers).get(
              'authorization',
            )
            return successfulResponse()
          }) as typeof fetch,
        },
      },
    })
    const session = {
      services: {
        providerService: {
          current: () => binding,
          environment: () => environment,
        },
      },
    } as unknown as Session

    await runWithCurrentRuntimeSession(session, async () => {
      const client = await getproviderClient({ maxRetries: 0 })
      await exercise(client)
    })

    expect(capturedAuthorization).toBe('Bearer session-mistral-key')
  })

  test('keeps an explicit client fetch override ahead of the prepared fetch', async () => {
    let preparedFetchCalls = 0
    let overrideFetchCalls = 0
    const binding = providerBindingFixture({
      provider: 'mistral',
      model: 'mistral-medium-latest',
      environment: { MISTRAL_API_KEY: 'prepared-mistral-key' },
      factoryOptions: {
        extra: {
          fetchImpl: (async () => {
            preparedFetchCalls += 1
            return successfulResponse()
          }) as typeof fetch,
        },
      },
    })

    const client = await getproviderClient({
      maxRetries: 0,
      providerBinding: binding,
      fetchOverride: (async () => {
        overrideFetchCalls += 1
        return successfulResponse()
      }) as typeof fetch,
    })
    await exercise(client)

    expect(overrideFetchCalls).toBe(1)
    expect(preparedFetchCalls).toBe(0)
  })
})
