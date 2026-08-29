import { afterEach, describe, expect, test } from 'bun:test'
import {
  checkIsAgenCNativeProvider as checkIsAgenCNativeProviderUnbound,
  getAgentModel as getAgentModelUnbound,
} from '../../../src/utils/model/agent.ts'
import { ConfigStore } from '../../../src/config/store.ts'
import { defaultConfig } from '../../../src/config/schema.ts'
import { runWithStartupProviderSelection } from '../../../src/utils/model/providers.ts'
import { runWithCanonicalSettingsAuthority } from '../../../src/utils/settings/canonicalAuthority.ts'

const providerEnvKeys = [
  'AGENC_PROVIDER',
  'AGENC_MODEL',
  'ANTHROPIC_BASE_URL',
  'MINIMAX_API_KEY',
  'OPENAI_API_BASE',
  'OPENAI_BASE_URL',
  'XAI_API_KEY',
] as const

const originalProviderEnv = Object.fromEntries(
  providerEnvKeys.map(key => [key, process.env[key]]),
) as Record<(typeof providerEnvKeys)[number], string | undefined>

function clearProviderEnv(): void {
  for (const key of providerEnvKeys) {
    delete process.env[key]
  }
}

function restoreProviderEnv(): void {
  clearProviderEnv()
  for (const [key, value] of Object.entries(originalProviderEnv)) {
    if (value !== undefined) {
      process.env[key] = value
    }
  }
}

function useProvider(
  provider:
    | 'agenc'
    | 'custom-first-party'
    | 'first-party'
    | 'gemini'
    | 'github'
    | 'minimax'
    | 'mistral'
    | 'nvidia-nim'
    | 'openai',
): void {
  clearProviderEnv()

  switch (provider) {
    case 'agenc':
      process.env.AGENC_PROVIDER = 'agenc'
      process.env.AGENC_MODEL = 'agenc'
      break
    case 'custom-first-party':
      process.env.AGENC_PROVIDER = 'anthropic'
      process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com'
      break
    case 'first-party':
      process.env.AGENC_PROVIDER = 'anthropic'
      break
    case 'gemini':
      process.env.AGENC_PROVIDER = 'gemini'
      break
    case 'github':
      process.env.AGENC_PROVIDER = 'github'
      break
    case 'minimax':
      process.env.AGENC_PROVIDER = 'minimax'
      break
    case 'mistral':
      process.env.AGENC_PROVIDER = 'mistral'
      break
    case 'nvidia-nim':
      process.env.AGENC_PROVIDER = 'nvidia-nim'
      break
    case 'openai':
      process.env.AGENC_PROVIDER = 'openai'
      process.env.AGENC_MODEL = 'gpt-4o-mini'
      break
  }
}

function withSelectedProvider<T>(
  operation: () => T,
  availableModels?: readonly string[],
): T {
  const provider = process.env.AGENC_PROVIDER
  if (!provider) throw new Error('test provider must be selected')
  const model = process.env.AGENC_MODEL ?? 'test-model'
  const store = new ConfigStore({
    home: '/tmp/agenc-agent-model-authority',
    env: {},
    base: {
      ...defaultConfig(),
      ...(availableModels === undefined ? {} : { availableModels }),
    },
  })
  return runWithCanonicalSettingsAuthority(store, () =>
    runWithStartupProviderSelection(
      { provider, model, environment: { ...process.env } },
      operation,
    )
  )
}

const getAgentModel = (...args: Parameters<typeof getAgentModelUnbound>) =>
  withSelectedProvider(() => getAgentModelUnbound(...args))

const getAgentModelWithPolicy = (
  args: Parameters<typeof getAgentModelUnbound>,
  availableModels: readonly string[],
) => withSelectedProvider(
  () => getAgentModelUnbound(...args),
  availableModels,
)

const checkIsAgenCNativeProvider = () =>
  withSelectedProvider(checkIsAgenCNativeProviderUnbound)

describe('getAgentModel provider-aware fallback', () => {
  afterEach(() => {
    restoreProviderEnv()
  })

  describe('AgenC-native providers', () => {
    test('haiku alias resolves to haiku model for official provider API', () => {
      useProvider('first-party')

      const result = getAgentModel(
        'haiku',
        'claude-sonnet-4-6',
        undefined,
      )

      expect(result).toContain('haiku')
      expect(result).not.toBe('claude-sonnet-4-6')
    })

    test.each([
      ['agent definition', ['best', 'claude-sonnet-4-6', undefined]],
      ['tool argument', [undefined, 'claude-sonnet-4-6', 'opus']],
    ] as const)(
      'rejects a %s model outside managed availableModels',
      (_source, args) => {
        useProvider('first-party')

        expect(() =>
          getAgentModelWithPolicy(
            args as Parameters<typeof getAgentModelUnbound>,
            ['sonnet'],
          )
        ).toThrow('managed availableModels policy')
      },
    )
  })

  describe('Non-AgenC-native providers', () => {
    test('haiku alias inherits parent model for openai provider', () => {
      useProvider('openai')

      const result = getAgentModel(
        'haiku',
        'gpt-4o-mini',
        undefined,
      )

      expect(result).toBe('gpt-4o-mini')
    })

    test('haiku alias inherits parent model for Gemini provider', () => {
      useProvider('gemini')

      const result = getAgentModel(
        'haiku',
        'gemini-2.5-pro',
        undefined,
      )

      expect(result).toBe('gemini-2.5-pro')
    })

    test('haiku alias inherits parent model for custom provider-compatible URL', () => {
      useProvider('custom-first-party')

      const result = getAgentModel(
        'haiku',
        'claude-sonnet-4-6',
        undefined,
      )

      expect(result).toBe('claude-sonnet-4-6')
    })

    test('sonnet alias inherits parent model for openai provider', () => {
      useProvider('openai')

      const result = getAgentModel(
        'sonnet',
        'gpt-4o-mini',
        undefined,
      )

      expect(result).toBe('gpt-4o-mini')
    })

    test('haiku alias inherits parent model for Mistral provider', () => {
      useProvider('mistral')

      const result = getAgentModel(
        'haiku',
        'mistral-small-latest',
        undefined,
      )

      expect(result).toBe('mistral-small-latest')
    })

    test('haiku alias inherits parent model for GitHub Copilot provider', () => {
      useProvider('github')

      const result = getAgentModel(
        'haiku',
        'gpt-4o-mini',
        undefined,
      )

      expect(result).toBe('gpt-4o-mini')
    })

    test('haiku alias inherits parent model for NVIDIA NIM provider', () => {
      useProvider('nvidia-nim')

      const result = getAgentModel(
        'haiku',
        'meta/llama-3.1-8b-instruct',
        undefined,
      )

      expect(result).toBe('meta/llama-3.1-8b-instruct')
    })

    test('haiku alias inherits parent model for MiniMax provider', () => {
      useProvider('minimax')

      const result = getAgentModel(
        'haiku',
        'MiniMax-M2.5-highspeed',
        undefined,
      )

      expect(result).toBe('MiniMax-M2.5-highspeed')
    })

    test('haiku alias inherits parent model for Agenc provider', () => {
      useProvider('agenc')

      const result = getAgentModel(
        'haiku',
        'gpt-5.5-mini',
        undefined,
      )

      expect(result).toBe('gpt-5.5-mini')
    })
  })

  describe('inherit behavior unchanged', () => {
    test('inherit always returns parent model regardless of provider', () => {
      useProvider('openai')

      const result = getAgentModel(
        'inherit',
        'gpt-4o',
        undefined,
      )

      expect(result).toBe('gpt-4o')
    })

  })

  describe('checkIsAgenCNativeProvider helper', () => {
    test('returns true for official provider API', () => {
      useProvider('first-party')

      expect(checkIsAgenCNativeProvider()).toBe(true)
    })

    test('returns false for openai provider', () => {
      useProvider('openai')

      expect(checkIsAgenCNativeProvider()).toBe(false)
    })

    test('returns false for custom provider URL', () => {
      useProvider('custom-first-party')

      expect(checkIsAgenCNativeProvider()).toBe(false)
    })
  })
})
