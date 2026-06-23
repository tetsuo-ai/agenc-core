import { afterEach, expect, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../../src/bootstrap/state.ts'
import { parseUserSpecifiedModel } from '../../../src/utils/model/model.ts'
import { getModelStrings } from '../../../src/utils/model/modelStrings.ts'

const originalEnv = {
  AGENC_USE_GITHUB: process.env.AGENC_USE_GITHUB,
  AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
  AGENC_USE_GEMINI: process.env.AGENC_USE_GEMINI,
  AGENC_USE_BEDROCK: process.env.AGENC_USE_BEDROCK,
  AGENC_USE_VERTEX: process.env.AGENC_USE_VERTEX,
  AGENC_USE_FOUNDRY: process.env.AGENC_USE_FOUNDRY,
  AGENC_USE_MISTRAL: process.env.AGENC_USE_MISTRAL,
  XAI_API_KEY: process.env.XAI_API_KEY,
}

function clearProviderFlags(): void {
  delete process.env.AGENC_USE_GITHUB
  delete process.env.AGENC_USE_OPENAI
  delete process.env.AGENC_USE_GEMINI
  delete process.env.AGENC_USE_BEDROCK
  delete process.env.AGENC_USE_VERTEX
  delete process.env.AGENC_USE_FOUNDRY
  delete process.env.AGENC_USE_MISTRAL
  delete process.env.XAI_API_KEY
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  resetModelStringsForTestingOnly()
})

test('GitHub provider model strings are concrete IDs', () => {
  clearProviderFlags()
  process.env.AGENC_USE_GITHUB = '1'

  const modelStrings = getModelStrings()

  for (const value of Object.values(modelStrings)) {
    expect(typeof value).toBe('string')
    expect(value.trim().length).toBeGreaterThan(0)
  }
})

test('GitHub provider model strings are safe to parse', () => {
  clearProviderFlags()
  process.env.AGENC_USE_GITHUB = '1'

  const modelStrings = getModelStrings()

  expect(() => parseUserSpecifiedModel(modelStrings.sonnet46 as any)).not.toThrow()
})

// Regression: only AGENC_OPUS_4_6_CONFIG defines `xai`/`mistral` keys, so for
// every other ModelKey the provider-specific lookup was undefined at runtime
// (tsc-blind because ModelConfig has an open index signature). Downstream this
// produced model IDs like 'undefined[1m]' in the /model picker.
test('xai provider model strings are concrete IDs for every model key', () => {
  clearProviderFlags()
  process.env.XAI_API_KEY = 'xai-test-key'

  const modelStrings = getModelStrings()

  const entries = Object.entries(modelStrings)
  expect(entries.length).toBeGreaterThan(0)
  for (const [key, value] of entries) {
    expect(value, `xai model string for key "${key}"`).toBeDefined()
    expect(typeof value).toBe('string')
    expect((value as string).trim().length).toBeGreaterThan(0)
  }
})

test('mistral provider model strings are concrete IDs for every model key', () => {
  clearProviderFlags()
  process.env.AGENC_USE_MISTRAL = '1'

  const modelStrings = getModelStrings()

  const entries = Object.entries(modelStrings)
  expect(entries.length).toBeGreaterThan(0)
  for (const [key, value] of entries) {
    expect(value, `mistral model string for key "${key}"`).toBeDefined()
    expect(typeof value).toBe('string')
    expect((value as string).trim().length).toBeGreaterThan(0)
  }
})
