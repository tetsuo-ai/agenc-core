import { afterEach, expect, test } from 'bun:test'
import {
  getAPIProvider,
  isGithubNativeAnthropicMode,
  usesAnthropicAccountFlow,
} from '../../../src/utils/model/providers.ts'

const originalEnv = {
  AGENC_USE_GEMINI: process.env.AGENC_USE_GEMINI,
  AGENC_USE_GITHUB: process.env.AGENC_USE_GITHUB,
  AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
  AGENC_USE_MISTRAL: process.env.AGENC_USE_MISTRAL,
  AGENC_USE_MINIMAX: process.env.AGENC_USE_MINIMAX,
  NVIDIA_NIM: process.env.NVIDIA_NIM,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  XAI_API_KEY: process.env.XAI_API_KEY,
}

afterEach(() => {
  for (const key of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }
})

function clearProviderEnv(): void {
  delete process.env.AGENC_USE_GEMINI
  delete process.env.AGENC_USE_GITHUB
  delete process.env.AGENC_USE_OPENAI
  delete process.env.AGENC_USE_MISTRAL
  delete process.env.AGENC_USE_MINIMAX
  delete process.env.NVIDIA_NIM
  delete process.env.MINIMAX_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_MODEL
  delete process.env.XAI_API_KEY
}

test('first-party provider keeps provider account setup flow enabled', () => {
  clearProviderEnv()
  expect(getAPIProvider()).toBe('firstParty')
  expect(usesAnthropicAccountFlow()).toBe(true)
})

test.each([
  ['AGENC_USE_OPENAI', 'openai'],
  ['AGENC_USE_GITHUB', 'github'],
  ['AGENC_USE_GEMINI', 'gemini'],
  ['AGENC_USE_MISTRAL', 'mistral'],
  ['AGENC_USE_MINIMAX', 'minimax'],
  ['NVIDIA_NIM', 'nvidia-nim'],
] as const)(
  '%s disables provider account setup flow',
  (envKey, provider) => {
    clearProviderEnv()
    process.env[envKey] = '1'

    expect(getAPIProvider()).toBe(provider)
    expect(usesAnthropicAccountFlow()).toBe(false)
  },
)

test('MINIMAX_API_KEY disables provider account setup flow', () => {
  clearProviderEnv()
  process.env.MINIMAX_API_KEY = 'minimax-test-key'

  expect(getAPIProvider()).toBe('minimax')
  expect(usesAnthropicAccountFlow()).toBe(false)
})

test('GEMINI takes precedence over GitHub when both are set', () => {
  clearProviderEnv()
  process.env.AGENC_USE_GEMINI = '1'
  process.env.AGENC_USE_GITHUB = '1'

  expect(getAPIProvider()).toBe('gemini')
})

test.each([
  ['AGENC_USE_MISTRAL', 'mistral'],
  ['AGENC_USE_GITHUB', 'github'],
  ['AGENC_USE_OPENAI', 'openai'],
] as const)(
  '%s takes precedence over ambient MiniMax credentials',
  (envKey, provider) => {
    clearProviderEnv()
    process.env.MINIMAX_API_KEY = 'ambient-minimax-key'
    process.env[envKey] = '1'
    if (envKey === 'AGENC_USE_OPENAI') {
      process.env.OPENAI_MODEL = 'gpt-4o'
    }

    expect(getAPIProvider()).toBe(provider)
  },
)

test('explicit openai flag takes precedence over stale NVIDIA_NIM', () => {
  clearProviderEnv()
  process.env.NVIDIA_NIM = '1'
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_MODEL = 'gpt-4o'

  expect(getAPIProvider()).toBe('openai')
})

test('explicit local openai-compatible base URLs stay on the openai provider', () => {
  clearProviderEnv()
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'

  expect(getAPIProvider()).toBe('openai')
})

test('agenc aliases still resolve to the agenc provider without a non-agenc base URL', () => {
  clearProviderEnv()
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_MODEL = 'agencplan'

  expect(getAPIProvider()).toBe('agenc')
})

test('XAI_API_KEY resolves to the xai provider', () => {
  clearProviderEnv()
  process.env.AGENC_USE_OPENAI = '1'
  process.env.XAI_API_KEY = 'xai-test-key'
  process.env.OPENAI_BASE_URL = 'https://api.x.ai/v1'
  process.env.OPENAI_MODEL = 'grok-4'

  expect(getAPIProvider()).toBe('xai')
})

test('official openai base URLs now keep provider detection on openai for aliases', () => {
  clearProviderEnv()
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'

  expect(getAPIProvider()).toBe('openai')
})

// isGithubNativeAnthropicMode

test('isGithubNativeAnthropicMode: false when AGENC_USE_GITHUB is not set', () => {
  clearProviderEnv()
  process.env.OPENAI_MODEL = 'claude-sonnet-4-5'
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: true for bare provider-native model via OPENAI_MODEL', () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'claude-sonnet-4-5'
  expect(isGithubNativeAnthropicMode()).toBe(true)
})

test('isGithubNativeAnthropicMode: true for github:copilot provider-native compound format', () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot:claude-sonnet-4'
  expect(isGithubNativeAnthropicMode()).toBe(true)
})

test('isGithubNativeAnthropicMode: true when resolvedModel is provider-native', () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot'
  expect(isGithubNativeAnthropicMode('claude-haiku-4-5')).toBe(true)
})

test('isGithubNativeAnthropicMode: false for generic github:copilot alias', () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot'
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: false for non-AgenC model', () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'gpt-4o'
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: false for github:copilot:gpt- model', () => {
  clearProviderEnv()
  process.env.AGENC_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot:gpt-4o'
  expect(isGithubNativeAnthropicMode()).toBe(false)
})
