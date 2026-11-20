import { expect, test, vi } from 'vitest'

// The OpenAI fallbacks in utils/model/model.ts answer when the session has
// selected OpenAI without a model of its own.
vi.mock('../../../src/utils/model/providers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/utils/model/providers.js')>()
  return {
    ...original,
    getAPIProvider: () => 'openai',
    getSelectedProviderModel: () => '',
    getSelectedProviderName: () => 'openai',
  }
})

const {
  getBestModel,
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
} = await import('../../../src/utils/model/model.js')

test('every OpenAI tier fallback names GPT-6.2 Astra', () => {
  expect(getDefaultOpusModel()).toBe('gpt-6.2-astra')
  expect(getBestModel()).toBe('gpt-6.2-astra')
  expect(getDefaultSonnetModel()).toBe('gpt-6.2-astra')
  expect(getDefaultHaikuModel()).toBe('gpt-6.2-astra')
  expect(getSmallFastModel()).toBe('gpt-6.2-astra')
  expect(getDefaultMainLoopModelSetting()).toBe('gpt-6.2-astra')
})
