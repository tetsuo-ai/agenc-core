import { expect, test } from 'bun:test'

import {
  getLocalProviderRetryBaseUrls,
  isLocalProviderUrl,
  resolveProviderRequest,
  shouldAttemptLocalToollessRetry,
} from '../../../src/services/api/providerConfig.ts'

function providerSelection(
  model: string,
  overrides: Readonly<Record<string, string | undefined>>,
) {
  return {
    model,
    baseUrl: overrides.OPENAI_BASE_URL ?? '',
    ...(overrides.OPENAI_API_FORMAT !== undefined
      ? { apiFormat: overrides.OPENAI_API_FORMAT }
      : {}),
  }
}

test('treats localhost endpoints as local', () => {
  expect(isLocalProviderUrl('http://localhost:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://127.0.0.1:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://0.0.0.0:11434/v1')).toBe(true)
  // Full 127.0.0.0/8 loopback range should be treated as local
  expect(isLocalProviderUrl('http://127.0.0.2:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://127.1.2.3:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://127.255.255.255:11434/v1')).toBe(true)
})

test('treats private IPv4 endpoints as local', () => {
  expect(isLocalProviderUrl('http://10.0.0.1:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://172.16.0.1:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://192.168.0.1:11434/v1')).toBe(true)
})

test('treats .local hostnames as local', () => {
  expect(isLocalProviderUrl('http://ollama.local:11434/v1')).toBe(true)
})

test('treats private IPv6 endpoints as local', () => {
  expect(isLocalProviderUrl('http://[fd00::1]:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://[fe80::1]:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://[::1]:11434/v1')).toBe(true)
})

test('treats public hosts as remote', () => {
  expect(isLocalProviderUrl('http://203.0.113.1:11434/v1')).toBe(false)
  expect(isLocalProviderUrl('https://example.com/v1')).toBe(false)
  expect(isLocalProviderUrl('http://[2001:4860:4860::8888]:11434/v1')).toBe(false)
})

test('keeps providerCode alias models on chat completions for local openai-compatible providers', () => {
  const selection = providerSelection('gpt-5.4', {
    OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1',
  })

  expect(resolveProviderRequest({ provider: 'openai-compatible', ...selection })).toMatchObject({
    transport: 'chat_completions',
    requestedModel: 'gpt-5.4',
    resolvedModel: 'gpt-5.4',
    baseUrl: 'http://127.0.0.1:8080/v1',
  })
})

test('normalizes collision-safe GitHub Copilot catalog models for requests', () => {
  expect(resolveProviderRequest({
    provider: 'github',
    model: 'github:copilot:gpt-5.3-codex',
    baseUrl: 'https://api.githubcopilot.com',
  })).toMatchObject({
    requestedModel: 'github:copilot:gpt-5.3-codex',
    resolvedModel: 'gpt-5.3-codex',
  })
})

test('uses responses transport when provider-compatible API format requests responses', () => {
  const selection = providerSelection('gpt-5.4', {
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_API_FORMAT: 'responses',
  })

  expect(resolveProviderRequest({ provider: 'openai-compatible', ...selection })).toMatchObject({
    transport: 'responses',
    requestedModel: 'gpt-5.4',
    resolvedModel: 'gpt-5.4',
    baseUrl: 'https://api.openai.com/v1',
  })
})

test('keeps ProviderCode backend on ProviderCode responses transport even when API format is set', () => {
  const selection = providerSelection('providerCodeplan', {
    OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
    OPENAI_API_FORMAT: 'chat_completions',
  })

  expect(resolveProviderRequest({ provider: 'openai-compatible', ...selection })).toMatchObject({
    transport: 'providerCode_responses',
    requestedModel: 'providerCodeplan',
    resolvedModel: 'gpt-5.5',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
  })
})

test('uses only explicit request inputs after ambient selection mutates', () => {
  const originalProvider = process.env.AGENC_PROVIDER
  const originalModel = process.env.AGENC_MODEL
  const originalBaseUrl = process.env.OPENAI_BASE_URL

  try {
    process.env.AGENC_PROVIDER = 'openai'
    process.env.AGENC_MODEL = 'ambient-model'
    process.env.OPENAI_BASE_URL = 'https://ambient.example/v1'

    expect(resolveProviderRequest({
      provider: 'openai-compatible',
      model: 'captured-model',
      baseUrl: 'http://127.0.0.1:8080/v1',
    })).toMatchObject({
      requestedModel: 'captured-model',
      resolvedModel: 'captured-model',
      baseUrl: 'http://127.0.0.1:8080/v1',
    })
  } finally {
    if (originalProvider === undefined) delete process.env.AGENC_PROVIDER
    else process.env.AGENC_PROVIDER = originalProvider
    if (originalModel === undefined) delete process.env.AGENC_MODEL
    else process.env.AGENC_MODEL = originalModel
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalBaseUrl
  }
})

test('requires provider, model, and base URL instead of falling back to ambient state', () => {
  expect(() =>
    resolveProviderRequest({
      provider: '',
      model: 'gpt-4.1',
      baseUrl: 'https://api.openai.com/v1',
    }),
  ).toThrow('prepared provider identity')
  expect(() =>
    resolveProviderRequest({
      provider: 'openai',
      model: '',
      baseUrl: 'https://api.openai.com/v1',
    }),
  ).toThrow('prepared model')
  expect(() =>
    resolveProviderRequest({
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: '',
    }),
  ).toThrow('prepared base URL')
})

test('derives local retry base URLs with /v1 and loopback fallback candidates', () => {
  expect(getLocalProviderRetryBaseUrls('http://localhost:11434')).toEqual([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434',
    'http://127.0.0.1:11434/v1',
  ])
})

test('does not derive local retry base URLs for remote providers', () => {
  expect(getLocalProviderRetryBaseUrls('https://api.openai.com/v1')).toEqual([])
})

test('enables local toolless retry for likely Ollama endpoints with tools', () => {
  expect(
    shouldAttemptLocalToollessRetry({
      baseUrl: 'http://localhost:11434/v1',
      hasTools: true,
    }),
  ).toBe(true)
})

test('disables local toolless retry when no tools are present', () => {
  expect(
    shouldAttemptLocalToollessRetry({
      baseUrl: 'http://localhost:11434/v1',
      hasTools: false,
    }),
  ).toBe(false)
})

test('disables local toolless retry for non-Ollama local endpoints', () => {
  expect(
    shouldAttemptLocalToollessRetry({
      baseUrl: 'http://localhost:1234/v1',
      hasTools: true,
    }),
  ).toBe(false)
})
