import { describe, expect, test } from 'bun:test'
import {
  parseOpenAiCompatibleApiFormat,
  resolveProviderRuntimeRequest,
} from '../../src/llm/provider-request.ts'
import { resolveProviderCredentialAuthority } from '../../src/llm/provider-options.ts'
import { createProvider } from '../../src/llm/provider.ts'
import { bindingFromProvider } from '../../src/session/provider-service.ts'

describe('provider runtime request', () => {
  test('prepares compatibility transport inputs at provider ingress', () => {
    const result = resolveProviderRuntimeRequest({
      provider: 'openai-compatible',
      model: 'bound-model',
      config: {},
      environment: {
        API_TIMEOUT_MS: '42000',
        OPENAI_API_FORMAT: 'responses-api',
        OPENAI_AUTH_HEADER: 'X-Custom-Authorization',
        OPENAI_AUTH_HEADER_VALUE: 'prepared-auth-value',
        OPENAI_AUTH_SCHEME: 'BEARER',
        AZURE_OPENAI_API_VERSION: '2026-08-01',
        ANTHROPIC_CUSTOM_HEADERS:
          'Authorization: stale-token\nX-API-Key: stale-key\nX-Prepared: first\nX-Second: value:with:colons',
      },
    })

    expect(result.requested.timeoutMs).toBe(42_000)
    expect(result.requested.extra).toMatchObject({
      useResponsesApi: true,
      openAiCompatibility: {
        authHeader: 'X-Custom-Authorization',
        authHeaderValue: 'prepared-auth-value',
        authScheme: 'bearer',
        azureApiVersion: '2026-08-01',
      },
    })
    expect(result.requested.extra?.defaultHeaders).toBeUndefined()

    const authority = resolveProviderCredentialAuthority(
      'openai-compatible',
      result.requested,
      { OPENAI_COMPATIBLE_API_KEY: 'prepared-key' },
    )
    const provider = createProvider(
      'openai-compatible',
      authority.factoryOptions,
    )
    const binding = bindingFromProvider({
      provider,
      providerName: 'openai-compatible',
      model: 'bound-model',
    })

    expect(binding.provider).toBe('openai-compatible')
    expect(binding.model).toBe('bound-model')
    expect(binding.factoryOptions.timeoutMs).toBe(42_000)
    expect(binding.factoryOptions.apiKey).toBe('prepared-key')
    expect(binding.factoryOptions.extra).toMatchObject({
      useResponsesApi: true,
      openAiCompatibility: {
        authHeader: 'X-Custom-Authorization',
        authHeaderValue: 'prepared-auth-value',
        authScheme: 'bearer',
        azureApiVersion: '2026-08-01',
      },
    })
  })

  test('keeps configured timeout authority ahead of the environment fallback', () => {
    const result = resolveProviderRuntimeRequest({
      provider: 'openrouter',
      model: 'x-ai/grok-4.6',
      config: {
        providers: {
          openrouter: { timeout_ms: 12_000 },
        },
      },
      environment: { API_TIMEOUT_MS: '42000' },
    })

    expect(result.requested.timeoutMs).toBe(12_000)
  })

  test('retains custom credential headers only for the Anthropic binding', () => {
    const anthropic = resolveProviderRuntimeRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      config: {},
      environment: {
        ANTHROPIC_CUSTOM_HEADERS:
          'Authorization: provider-token\nX-Safe: keep-me',
      },
    })
    const external = resolveProviderRuntimeRequest({
      provider: 'openrouter',
      model: 'x-ai/grok-4.6',
      config: {},
      environment: {
        ANTHROPIC_CUSTOM_HEADERS:
          'Authorization: provider-token\nX-Safe: keep-me',
      },
    })

    expect(anthropic.requested.extra?.defaultHeaders).toEqual({
      Authorization: 'provider-token',
      'X-Safe': 'keep-me',
    })
    expect(external.requested.extra?.defaultHeaders).toBeUndefined()
  })

  test('binds Anthropic beta controls only from explicit factory options', () => {
    const previousAnthropicBetas = process.env.ANTHROPIC_BETAS
    const previousContextManagement = process.env.USE_API_CONTEXT_MANAGEMENT
    process.env.ANTHROPIC_BETAS = 'ambient-beta-must-not-leak'
    process.env.USE_API_CONTEXT_MANAGEMENT = '1'

    try {
      const poisonedEnvironment = {
        ANTHROPIC_BETAS: 'session-beta-must-not-leak',
        USE_API_CONTEXT_MANAGEMENT: '1',
        AGENC_DISABLE_EXPERIMENTAL_BETAS: '0',
      }
      const withoutExplicitControls = resolveProviderRuntimeRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        config: {},
        environment: poisonedEnvironment,
      })
      const explicitContextManagement = {
        edits: [{ type: 'clear_tool_uses_20250919' }],
      }
      const withExplicitControls = resolveProviderRuntimeRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        config: {},
        environment: poisonedEnvironment,
        baseExtra: {
          betaHeaders: ['explicit-beta'],
          contextManagement: explicitContextManagement,
        },
      })

      expect(withoutExplicitControls.requested.extra).toBeUndefined()
      expect(withExplicitControls.requested.extra?.betaHeaders).toEqual([
        'explicit-beta',
      ])
      expect(withExplicitControls.requested.extra?.contextManagement).toBe(
        explicitContextManagement,
      )
    } finally {
      if (previousAnthropicBetas === undefined) {
        delete process.env.ANTHROPIC_BETAS
      } else {
        process.env.ANTHROPIC_BETAS = previousAnthropicBetas
      }
      if (previousContextManagement === undefined) {
        delete process.env.USE_API_CONTEXT_MANAGEMENT
      } else {
        process.env.USE_API_CONTEXT_MANAGEMENT = previousContextManagement
      }
    }
  })

  test('does not project stale OpenAI compatibility controls into other providers', () => {
    const result = resolveProviderRuntimeRequest({
      provider: 'mistral',
      model: 'mistral-medium-latest',
      config: {},
      environment: {
        OPENAI_AUTH_HEADER: 'Authorization',
        OPENAI_AUTH_HEADER_VALUE: 'stale-openai-token',
        OPENAI_AUTH_SCHEME: 'bearer',
        OPENAI_API_FORMAT: 'responses',
      },
    })

    expect(result.requested.extra?.openAiCompatibility).toBeUndefined()
    expect(result.requested.extra?.useResponsesApi).toBeUndefined()
  })

  test('uses one format parser for ingress and request routing aliases', () => {
    expect(parseOpenAiCompatibleApiFormat('responses-api')).toBe('responses')
    expect(parseOpenAiCompatibleApiFormat('chat completion')).toBe(
      'chat_completions',
    )
    expect(parseOpenAiCompatibleApiFormat('unsupported')).toBeUndefined()
  })
})
