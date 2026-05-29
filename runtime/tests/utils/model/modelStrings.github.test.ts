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
}

function clearProviderFlags(): void {
  delete process.env.AGENC_USE_GITHUB
  delete process.env.AGENC_USE_OPENAI
  delete process.env.AGENC_USE_GEMINI
  delete process.env.AGENC_USE_BEDROCK
  delete process.env.AGENC_USE_VERTEX
  delete process.env.AGENC_USE_FOUNDRY
}

afterEach(() => {
  process.env.AGENC_USE_GITHUB = originalEnv.AGENC_USE_GITHUB
  process.env.AGENC_USE_OPENAI = originalEnv.AGENC_USE_OPENAI
  process.env.AGENC_USE_GEMINI = originalEnv.AGENC_USE_GEMINI
  process.env.AGENC_USE_BEDROCK = originalEnv.AGENC_USE_BEDROCK
  process.env.AGENC_USE_VERTEX = originalEnv.AGENC_USE_VERTEX
  process.env.AGENC_USE_FOUNDRY = originalEnv.AGENC_USE_FOUNDRY
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
