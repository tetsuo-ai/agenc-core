// The TUI limit helpers resolve OpenAI's registered reasoning rows (GPT-5.6,
// GPT-6 Astra, Sol and Luna) from the model catalog, the same source the
// daemon and Desktop use: 1,050,000 context and 128,000 max output
// (developers.openai.com model pages, 2026-09-06 and 2026-09-22). The legacy
// OpenAI-compatible table has no rows for them, so it fell back to 128K
// context and a 64K output ceiling.
import { expect, test } from 'bun:test'

import {
  getContextWindowForModelForContext,
  getModelMaxOutputTokensForContext,
} from '../../src/utils/context.ts'

const openai = { provider: 'openai', environment: {} }

test.each([
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'openai/gpt-6-sol',
])('%s reports the registered OpenAI limits in the TUI helpers', (model) => {
  expect(getContextWindowForModelForContext(model, openai)).toBe(1_050_000)
  expect(getModelMaxOutputTokensForContext(model, openai)).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })
})

test('an unregistered GPT-6 variant keeps the conservative fallback', () => {
  expect(getContextWindowForModelForContext('gpt-6-sol-unverified', openai)).toBe(128_000)
})
