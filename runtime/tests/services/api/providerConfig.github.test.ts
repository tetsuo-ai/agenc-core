import { expect, test } from 'bun:test'

import { normalizeGithubModelForEndpoint } from '../../../src/llm/providers/github/model-routing.ts'
import { BUILT_IN_PROVIDER_DEFAULT_MODELS } from '../../../src/llm/registry/provider-info.ts'
import {
  resolveProviderRequest,
} from '../../../src/services/api/providerConfig.ts'

test.each([
  ['copilot', BUILT_IN_PROVIDER_DEFAULT_MODELS.github],
  ['github:copilot', BUILT_IN_PROVIDER_DEFAULT_MODELS.github],
  ['', BUILT_IN_PROVIDER_DEFAULT_MODELS.github],
  ['github:gpt-5.3-codex', 'gpt-5.3-codex'],
  ['gpt-5.3-codex', 'gpt-5.3-codex'],
  ['github:copilot?reasoning=high', BUILT_IN_PROVIDER_DEFAULT_MODELS.github],
  // The shared endpoint projector preserves provider qualification for GitHub Models.
  ['github:openai/gpt-4.1', 'openai/gpt-4.1'],
  ['openai/gpt-4.1', 'openai/gpt-4.1'],
] as const)('normalizeGithubModelForEndpoint(%s, models) -> %s', (input, expected) => {
  expect(normalizeGithubModelForEndpoint(input, 'models')).toBe(expected)
})

test('resolveProviderRequest applies GitHub normalization and transport for the GitHub provider', () => {
  const r = resolveProviderRequest({
    provider: 'github',
    model: 'github:gpt-5.3-codex',
    baseUrl: 'https://api.githubcopilot.com',
  })
  expect(r.resolvedModel).toBe('gpt-5.3-codex')
  expect(r.transport).toBe('providerCode_responses')
})

test('resolveProviderRequest routes GitHub GPT-5 providerCode models to responses transport', () => {
  const r = resolveProviderRequest({
    provider: 'github',
    model: 'gpt-5.3-providerCode',
    baseUrl: 'https://api.githubcopilot.com',
  })
  expect(r.resolvedModel).toBe('gpt-5.3-providerCode')
  expect(r.transport).toBe('providerCode_responses')
})

test('resolveProviderRequest keeps gpt-5-mini on chat_completions for GitHub', () => {
  const r = resolveProviderRequest({
    provider: 'github',
    model: 'gpt-5-mini',
    baseUrl: 'https://api.githubcopilot.com',
  })
  expect(r.resolvedModel).toBe('gpt-5-mini')
  expect(r.transport).toBe('chat_completions')
})

test('resolveProviderRequest leaves model unchanged without GitHub flag', () => {
  const r = resolveProviderRequest({
    provider: 'openai',
    model: 'github:gpt-5.3-codex',
    baseUrl: 'https://api.openai.com/v1',
  })
  expect(r.resolvedModel).toBe('github:gpt-5.3-codex')
})
