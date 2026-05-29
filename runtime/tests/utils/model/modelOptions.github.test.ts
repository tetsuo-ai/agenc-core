import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mock } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../../src/bootstrap/state.ts'
import { saveGlobalConfig } from '../../../src/utils/config.ts'

async function importFreshModelOptionsModule() {
  mock.restore()
  mock.module('./providers.js', () => ({
    getAPIProvider: () => 'github',
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`../../../src/utils/model/modelOptions.ts?ts=${nonce}`)
}

const originalEnv = {
  AGENC_USE_GITHUB: process.env.AGENC_USE_GITHUB,
  AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
  AGENC_USE_GEMINI: process.env.AGENC_USE_GEMINI,
  AGENC_USE_BEDROCK: process.env.AGENC_USE_BEDROCK,
  AGENC_USE_VERTEX: process.env.AGENC_USE_VERTEX,
  AGENC_USE_FOUNDRY: process.env.AGENC_USE_FOUNDRY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  ANTHROPIC_CUSTOM_MODEL_OPTION: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION,
}

beforeEach(() => {
  mock.restore()
  delete process.env.AGENC_USE_GITHUB
  delete process.env.AGENC_USE_OPENAI
  delete process.env.AGENC_USE_GEMINI
  delete process.env.AGENC_USE_BEDROCK
  delete process.env.AGENC_USE_VERTEX
  delete process.env.AGENC_USE_FOUNDRY
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_BASE_URL
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  mock.restore()
  process.env.AGENC_USE_GITHUB = originalEnv.AGENC_USE_GITHUB
  process.env.AGENC_USE_OPENAI = originalEnv.AGENC_USE_OPENAI
  process.env.AGENC_USE_GEMINI = originalEnv.AGENC_USE_GEMINI
  process.env.AGENC_USE_BEDROCK = originalEnv.AGENC_USE_BEDROCK
  process.env.AGENC_USE_VERTEX = originalEnv.AGENC_USE_VERTEX
  process.env.AGENC_USE_FOUNDRY = originalEnv.AGENC_USE_FOUNDRY
  process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION =
    originalEnv.ANTHROPIC_CUSTOM_MODEL_OPTION
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: [],
    additionalModelOptionsCacheScope: undefined,
    openaiAdditionalModelOptionsCache: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
    providerProfiles: [],
    activeProviderProfileId: undefined,
  }))
  resetModelStringsForTestingOnly()
})

test('GitHub provider exposes default + all Copilot models in /model options', async () => {
  process.env.AGENC_USE_GITHUB = '1'
  delete process.env.AGENC_USE_OPENAI
  delete process.env.AGENC_USE_GEMINI
  delete process.env.AGENC_USE_BEDROCK
  delete process.env.AGENC_USE_VERTEX
  delete process.env.AGENC_USE_FOUNDRY

  process.env.OPENAI_MODEL = 'gpt-4o'
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION

  const { getModelOptions } = await importFreshModelOptionsModule()
  const options = getModelOptions(false)
  const nonDefault = options.filter(
    (option: { value: unknown }) => option.value !== null,
  )

  expect(nonDefault.length).toBeGreaterThan(1)
  expect(nonDefault.some((o: { value: unknown }) => o.value === 'gpt-4o')).toBe(true)
  expect(nonDefault.some((o: { value: unknown }) => o.value === 'gpt-5.3-codex')).toBe(true)
})
