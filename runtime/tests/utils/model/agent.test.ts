import { afterEach, describe, expect, test } from 'bun:test'
import {
  checkIsAgenCNativeProvider,
  getAgentModel,
} from '../../../src/utils/model/agent.ts'

const providerEnvKeys = [
  'AGENC_USE_GEMINI',
  'AGENC_USE_MISTRAL',
  'AGENC_USE_GITHUB',
  'AGENC_USE_MINIMAX',
  'AGENC_USE_OPENAI',
  'ANTHROPIC_BASE_URL',
  'MINIMAX_API_KEY',
  'NVIDIA_NIM',
  'OPENAI_API_BASE',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
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
      process.env.AGENC_USE_OPENAI = '1'
      process.env.OPENAI_MODEL = 'agencspark'
      break
    case 'custom-first-party':
      process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com'
      break
    case 'first-party':
      break
    case 'gemini':
      process.env.AGENC_USE_GEMINI = '1'
      break
    case 'github':
      process.env.AGENC_USE_GITHUB = '1'
      break
    case 'minimax':
      process.env.MINIMAX_API_KEY = 'minimax-test-key'
      break
    case 'mistral':
      process.env.AGENC_USE_MISTRAL = '1'
      break
    case 'nvidia-nim':
      process.env.NVIDIA_NIM = '1'
      break
    case 'openai':
      process.env.AGENC_USE_OPENAI = '1'
      process.env.OPENAI_MODEL = 'gpt-4o-mini'
      break
  }
}

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
        'default',
      )

      expect(result).toContain('haiku')
      expect(result).not.toBe('claude-sonnet-4-6')
    })
  })

  describe('Non-AgenC-native providers', () => {
    test('haiku alias inherits parent model for openai provider', () => {
      useProvider('openai')

      const result = getAgentModel(
        'haiku',
        'gpt-4o-mini',
        undefined,
        'default',
      )

      expect(result).toBe('gpt-4o-mini')
    })

    test('haiku alias inherits parent model for Gemini provider', () => {
      useProvider('gemini')

      const result = getAgentModel(
        'haiku',
        'gemini-2.5-pro',
        undefined,
        'default',
      )

      expect(result).toBe('gemini-2.5-pro')
    })

    test('haiku alias inherits parent model for custom provider-compatible URL', () => {
      useProvider('custom-first-party')

      const result = getAgentModel(
        'haiku',
        'claude-sonnet-4-6',
        undefined,
        'default',
      )

      expect(result).toBe('claude-sonnet-4-6')
    })

    test('sonnet alias inherits parent model for openai provider', () => {
      useProvider('openai')

      const result = getAgentModel(
        'sonnet',
        'gpt-4o-mini',
        undefined,
        'default',
      )

      expect(result).toBe('gpt-4o-mini')
    })

    test('haiku alias inherits parent model for Mistral provider', () => {
      useProvider('mistral')

      const result = getAgentModel(
        'haiku',
        'mistral-small-latest',
        undefined,
        'default',
      )

      expect(result).toBe('mistral-small-latest')
    })

    test('haiku alias inherits parent model for GitHub Copilot provider', () => {
      useProvider('github')

      const result = getAgentModel(
        'haiku',
        'gpt-4o-mini',
        undefined,
        'default',
      )

      expect(result).toBe('gpt-4o-mini')
    })

    test('haiku alias inherits parent model for NVIDIA NIM provider', () => {
      useProvider('nvidia-nim')

      const result = getAgentModel(
        'haiku',
        'meta/llama-3.1-8b-instruct',
        undefined,
        'default',
      )

      expect(result).toBe('meta/llama-3.1-8b-instruct')
    })

    test('haiku alias inherits parent model for MiniMax provider', () => {
      useProvider('minimax')

      const result = getAgentModel(
        'haiku',
        'MiniMax-M2.5-highspeed',
        undefined,
        'default',
      )

      expect(result).toBe('MiniMax-M2.5-highspeed')
    })

    test('haiku alias inherits parent model for Agenc provider', () => {
      useProvider('agenc')

      const result = getAgentModel(
        'haiku',
        'gpt-5.5-mini',
        undefined,
        'default',
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
        'default',
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
