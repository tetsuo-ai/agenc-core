import { afterEach, expect, mock, test } from 'bun:test'

import { getAdditionalModelOptionsCacheScope } from '../../services/api/providerConfig.js'
import { getAPIProvider } from '../../utils/model/providers.js'

const originalEnv = {
  AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
  AGENC_USE_GEMINI: process.env.AGENC_USE_GEMINI,
  AGENC_USE_GITHUB: process.env.AGENC_USE_GITHUB,
  AGENC_USE_MISTRAL: process.env.AGENC_USE_MISTRAL,
  AGENC_USE_BEDROCK: process.env.AGENC_USE_BEDROCK,
  AGENC_USE_VERTEX: process.env.AGENC_USE_VERTEX,
  AGENC_USE_FOUNDRY: process.env.AGENC_USE_FOUNDRY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

afterEach(() => {
  mock.restore()
  process.env.AGENC_USE_OPENAI = originalEnv.AGENC_USE_OPENAI
  process.env.AGENC_USE_GEMINI = originalEnv.AGENC_USE_GEMINI
  process.env.AGENC_USE_GITHUB = originalEnv.AGENC_USE_GITHUB
  process.env.AGENC_USE_MISTRAL = originalEnv.AGENC_USE_MISTRAL
  process.env.AGENC_USE_BEDROCK = originalEnv.AGENC_USE_BEDROCK
  process.env.AGENC_USE_VERTEX = originalEnv.AGENC_USE_VERTEX
  process.env.AGENC_USE_FOUNDRY = originalEnv.AGENC_USE_FOUNDRY
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.OPENAI_API_BASE = originalEnv.OPENAI_API_BASE
  process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
})

test('opens the model picker without awaiting local model discovery refresh', async () => {
  process.env.AGENC_USE_OPENAI = '1'
  delete process.env.AGENC_USE_GEMINI
  delete process.env.AGENC_USE_GITHUB
  delete process.env.AGENC_USE_MISTRAL
  delete process.env.AGENC_USE_BEDROCK
  delete process.env.AGENC_USE_VERTEX
  delete process.env.AGENC_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
  process.env.OPENAI_MODEL = 'qwen2.5-coder-7b-instruct'

  let resolveDiscovery: (() => void) | undefined
  const discoverOpenAiCompatibleModelOptions = mock(
    () =>
      new Promise<void>(resolve => {
        resolveDiscovery = resolve
      }),
  )

  mock.module('../../utils/model/openaiModelDiscovery.js', () => ({
    discoverOpenAiCompatibleModelOptions,
  }))

  expect(getAdditionalModelOptionsCacheScope()).toBe('openai:http://127.0.0.1:8080/v1')

  const { call } = await import('./model.js')
  const result = await Promise.race([
    call(() => {}, {} as never, ''),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 50)),
  ])

  resolveDiscovery?.()

  expect(result).not.toBe('timeout')
})
