import { afterEach, beforeEach, expect, test } from 'bun:test'

import { saveGlobalConfig } from '../../../src/utils/config.ts'
import { getDefaultMainLoopModelSetting, getUserSpecifiedModelSetting } from '../../../src/utils/model/model.ts'

const env = {
  AGENC_USE_GITHUB: process.env.AGENC_USE_GITHUB,
  AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
  AGENC_USE_GEMINI: process.env.AGENC_USE_GEMINI,
  AGENC_USE_BEDROCK: process.env.AGENC_USE_BEDROCK,
  AGENC_USE_VERTEX: process.env.AGENC_USE_VERTEX,
  AGENC_USE_FOUNDRY: process.env.AGENC_USE_FOUNDRY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

beforeEach(() => {
  process.env.AGENC_USE_GITHUB = '1'
  delete process.env.AGENC_USE_OPENAI
  delete process.env.AGENC_USE_GEMINI
  delete process.env.AGENC_USE_BEDROCK
  delete process.env.AGENC_USE_VERTEX
  delete process.env.AGENC_USE_FOUNDRY
  delete process.env.OPENAI_MODEL
  saveGlobalConfig(current => ({
    ...current,
    model: ({ bad: true } as unknown) as string,
  }))
})

afterEach(() => {
  process.env.AGENC_USE_GITHUB = env.AGENC_USE_GITHUB
  process.env.AGENC_USE_OPENAI = env.AGENC_USE_OPENAI
  process.env.AGENC_USE_GEMINI = env.AGENC_USE_GEMINI
  process.env.AGENC_USE_BEDROCK = env.AGENC_USE_BEDROCK
  process.env.AGENC_USE_VERTEX = env.AGENC_USE_VERTEX
  process.env.AGENC_USE_FOUNDRY = env.AGENC_USE_FOUNDRY
  process.env.OPENAI_MODEL = env.OPENAI_MODEL
  saveGlobalConfig(current => ({
    ...current,
    model: undefined,
  }))
})

test('github default model setting ignores non-string saved model', () => {
  const model = getDefaultMainLoopModelSetting()
  expect(typeof model).toBe('string')
  expect(model).not.toBe('[object Object]')
  expect(model.length).toBeGreaterThan(0)
})

test('user specified model ignores non-string saved model', () => {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    expect(typeof model).toBe('string')
    expect(model).not.toBe('[object Object]')
  }
})
