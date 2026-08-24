import { expect, test } from 'bun:test'

import {
  DEFAULT_GITHUB_MODELS_API_MODEL,
  normalizeGithubModelsApiModel,
  resolveProviderRequest,
} from '../../../src/services/api/providerConfig.ts'

function providerEnvironment(
  provider: string,
  model: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    AGENC_PROVIDER: provider,
    AGENC_MODEL: model,
  })
}

test.each([
  ['copilot', DEFAULT_GITHUB_MODELS_API_MODEL],
  ['github:copilot', DEFAULT_GITHUB_MODELS_API_MODEL],
  ['', DEFAULT_GITHUB_MODELS_API_MODEL],
  ['github:gpt-4o', 'gpt-4o'],
  ['gpt-4o', 'gpt-4o'],
  ['github:copilot?reasoning=high', DEFAULT_GITHUB_MODELS_API_MODEL],
  // normalizeGithubModelsApiModel preserves provider prefix for models.github.ai compatibility
  ['github:openai/gpt-4.1', 'openai/gpt-4.1'],
  ['openai/gpt-4.1', 'openai/gpt-4.1'],
] as const)('normalizeGithubModelsApiModel(%s) -> %s', (input, expected) => {
  expect(normalizeGithubModelsApiModel(input)).toBe(expected)
})

test('resolveProviderRequest applies GitHub normalization for the GitHub provider', () => {
  const r = resolveProviderRequest({
    provider: 'github',
    model: 'github:gpt-4o',
    environment: providerEnvironment('github', 'github:gpt-4o'),
  })
  expect(r.resolvedModel).toBe('gpt-4o')
  expect(r.transport).toBe('chat_completions')
})

test('resolveProviderRequest routes GitHub GPT-5 providerCode models to responses transport', () => {
  const r = resolveProviderRequest({
    provider: 'github',
    model: 'gpt-5.3-providerCode',
    environment: providerEnvironment('github', 'gpt-5.3-providerCode'),
  })
  expect(r.resolvedModel).toBe('gpt-5.3-providerCode')
  expect(r.transport).toBe('providerCode_responses')
})

test('resolveProviderRequest keeps gpt-5-mini on chat_completions for GitHub', () => {
  const r = resolveProviderRequest({
    provider: 'github',
    model: 'gpt-5-mini',
    environment: providerEnvironment('github', 'gpt-5-mini'),
  })
  expect(r.resolvedModel).toBe('gpt-5-mini')
  expect(r.transport).toBe('chat_completions')
})

test('resolveProviderRequest leaves model unchanged without GitHub flag', () => {
  const r = resolveProviderRequest({
    provider: 'openai',
    model: 'github:gpt-4o',
    environment: providerEnvironment('openai', 'github:gpt-4o'),
  })
  expect(r.resolvedModel).toBe('github:gpt-4o')
})
