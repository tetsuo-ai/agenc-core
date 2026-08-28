import { describe, expect, test } from 'bun:test'
import {
  projectBoundProviderConnection,
} from '../../../src/llm/registry/provider-connection.ts'
import type { ProviderBinding } from '../../../src/session/provider-service.ts'

function binding(options: {
  provider: string
  model: string
  apiKey?: string
  authToken?: string
  baseURL?: string
  timeoutMs?: number
  extra?: Record<string, unknown>
}): ProviderBinding {
  return {
    provider: options.provider,
    model: options.model,
    instance: Object.freeze({ name: options.provider }) as unknown as ProviderBinding['instance'],
    factoryOptions: {
      model: options.model,
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.extra !== undefined ? { extra: options.extra } : {}),
    },
    revision: 0,
  }
}

describe('bound provider connection authority', () => {
  test('projects only the prepared factory options', () => {
    const connection = projectBoundProviderConnection({
      binding: binding({
        provider: 'openrouter',
        model: 'x-ai/grok-4.6',
        apiKey: 'prepared-key',
        baseURL: 'https://gateway.example/v1',
        timeoutMs: 42_000,
        extra: {
          useResponsesApi: true,
          defaultHeaders: { 'x-bound-header': 'bound' },
        },
      }),
      environment: {
        OPENROUTER_API_KEY: 'stale-key',
        OPENROUTER_BASE_URL: 'https://stale.example/v1',
        AGENC_MODEL: 'stale-model',
      },
    })

    expect(connection.provider).toBe('openrouter')
    expect(connection.transport).toBe('openai-compatible')
    expect(connection.model).toBe('x-ai/grok-4.6')
    expect(connection.apiKey).toBe('prepared-key')
    expect(connection.baseURL).toBe('https://gateway.example/v1')
    expect(connection.timeoutMs).toBe(42_000)
    expect(connection.extra.useResponsesApi).toBe(true)
    expect(connection.extra.defaultHeaders).toEqual({
      'x-bound-header': 'bound',
    })
  })

  test('keeps provider identity separate from the compatibility transport', () => {
    for (const provider of ['openrouter', 'groq', 'deepseek'] as const) {
      const connection = projectBoundProviderConnection({
        binding: binding({
          provider,
          model: `${provider}-model`,
          apiKey: `${provider}-key`,
          baseURL: `https://${provider}.example/v1`,
        }),
      })

      expect(connection.provider).toBe(provider)
      expect(connection.transport).toBe('openai-compatible')
    }
  })

  test('captures environment input instead of retaining a mutable reference', () => {
    const environment: Record<string, string | undefined> = {
      HTTPS_PROXY: 'https://first.example',
    }
    const connection = projectBoundProviderConnection({
      binding: binding({
        provider: 'ollama',
        model: 'local-model',
        baseURL: 'http://localhost:11434',
      }),
      environment,
    })

    environment.HTTPS_PROXY = 'https://second.example'

    expect(connection.environment.HTTPS_PROXY).toBe('https://first.example')
    expect(Object.isFrozen(connection.environment)).toBe(true)
    expect(Object.isFrozen(connection)).toBe(true)
  })

  test('snapshots nested prepared options instead of retaining mutable records', () => {
    const extra = {
      defaultHeaders: { 'x-bound': 'first' },
      openAiCompatibility: { authHeader: 'X-First-Auth' },
      oauth: {
        accessToken: 'first-token',
        refreshAccessToken: async () => ({ accessToken: 'refreshed' }),
      },
    }
    const connection = projectBoundProviderConnection({
      binding: binding({
        provider: 'openai',
        model: 'gpt-5.4',
        baseURL: 'https://api.openai.com/v1',
        extra: { ...extra, authMode: 'oauth' },
      }),
    })

    extra.defaultHeaders['x-bound'] = 'second'
    extra.openAiCompatibility.authHeader = 'X-Second-Auth'
    extra.oauth.accessToken = 'second-token'

    expect(connection.extra.defaultHeaders).toEqual({ 'x-bound': 'first' })
    expect(connection.extra.openAiCompatibility).toEqual({
      authHeader: 'X-First-Auth',
    })
    expect(connection.extra.oauth).toMatchObject({ accessToken: 'first-token' })
    expect(Object.isFrozen(connection.extra.defaultHeaders)).toBe(true)
    expect(Object.isFrozen(connection.extra.openAiCompatibility)).toBe(true)
    expect(Object.isFrozen(connection.extra.oauth)).toBe(true)
  })

  test('keeps concurrent provider bindings isolated', () => {
    const first = projectBoundProviderConnection({
      binding: binding({
        provider: 'groq',
        model: 'first-model',
        apiKey: 'first-key',
        baseURL: 'https://first.example/v1',
      }),
    })
    const second = projectBoundProviderConnection({
      binding: binding({
        provider: 'deepseek',
        model: 'second-model',
        apiKey: 'second-key',
        baseURL: 'https://second.example/v1',
      }),
    })

    expect(first).toMatchObject({
      provider: 'groq',
      model: 'first-model',
      apiKey: 'first-key',
    })
    expect(second).toMatchObject({
      provider: 'deepseek',
      model: 'second-model',
      apiKey: 'second-key',
    })
  })

  test('fails closed for an incomplete required credential binding', () => {
    expect(() =>
      projectBoundProviderConnection({
        binding: binding({
          provider: 'openrouter',
          model: 'x-ai/grok-4.6',
          baseURL: 'https://openrouter.ai/api/v1',
        }),
        environment: { OPENROUTER_API_KEY: 'fallback-key' },
      }),
    ).toThrow('OPENROUTER_API_KEY is required for OpenRouter provider')
  })

  test('accepts an already-prepared OAuth binding without an API key', () => {
    const connection = projectBoundProviderConnection({
      binding: binding({
        provider: 'openai',
        model: 'gpt-5.4',
        baseURL: 'https://api.openai.com/v1',
        extra: {
          authMode: 'oauth',
          oauth: {
            accessToken: 'prepared-access-token',
            refreshAccessToken: async () => ({
              accessToken: 'refreshed-access-token',
            }),
          },
        },
      }),
    })

    expect(connection.provider).toBe('openai')
    expect(connection.apiKey).toBeUndefined()
    expect(connection.extra.authMode).toBe('oauth')
  })

  test('preserves a prepared Anthropic bearer token separately from API keys', () => {
    const connection = projectBoundProviderConnection({
      binding: binding({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        authToken: 'prepared-bearer',
        baseURL: 'https://api.anthropic.com/v1',
      }),
    })

    expect(connection.transport).toBe('anthropic')
    expect(connection.authToken).toBe('prepared-bearer')
    expect(connection.apiKey).toBeUndefined()
  })

  test('projects GitHub Claude onto Anthropic transport without changing identity', () => {
    const connection = projectBoundProviderConnection({
      binding: binding({
        provider: 'github',
        model: 'claude-sonnet-4.6',
        apiKey: 'github-token',
        baseURL: 'https://api.githubcopilot.com',
      }),
    })

    expect(connection.provider).toBe('github')
    expect(connection.transport).toBe('anthropic')
  })

  test('fails closed instead of inventing a compatible provider endpoint', () => {
    expect(() =>
      projectBoundProviderConnection({
        binding: binding({
          provider: 'openrouter',
          model: 'x-ai/grok-4.6',
          apiKey: 'prepared-key',
        }),
      }),
    ).toThrow('openrouter provider binding has no prepared base URL')
  })

  test('keeps delegating and native bindings out of the compatibility shim', () => {
    const connections = [
      projectBoundProviderConnection({
        binding: binding({
          provider: 'agenc',
          model: 'managed-model',
        }),
      }),
      projectBoundProviderConnection({
        binding: binding({
          provider: 'grok',
          model: 'grok-composer',
        }),
      }),
      projectBoundProviderConnection({
        binding: binding({
          provider: 'openrouter',
          model: 'managed-model',
          extra: { managedCredential: true },
        }),
      }),
    ]

    expect(connections.map(connection => connection.transport)).toEqual([
      'native',
      'native',
      'native',
    ])
    expect(connections.every(connection => connection.baseURL === undefined)).toBe(
      true,
    )
  })

  test('rejects a model mismatch inside the prepared binding', () => {
    expect(() =>
      projectBoundProviderConnection({
        binding: {
          provider: 'ollama',
          model: 'session-model',
          instance: Object.freeze({ name: 'ollama' }) as unknown as ProviderBinding['instance'],
          factoryOptions: { model: 'different-model' },
          revision: 0,
        },
      }),
    ).toThrow('binding model does not match its prepared factory options')
  })
})
