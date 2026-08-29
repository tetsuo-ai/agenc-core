import { expect, test } from 'bun:test'

import { BUILT_IN_PROVIDER_DEFAULT_MODELS } from '../../../src/llm/registry/provider-info.ts'
import {
  getDefaultHaikuModel,
  getDefaultMainLoopModel,
  getDefaultMainLoopModelSetting,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getPublicModelDisplayName,
  getSmallFastModel,
} from '../../../src/utils/model/model.ts'
import {
  getSelectedProviderEnvironment,
  getSelectedProviderModel,
  runWithStartupProviderSelection,
} from '../../../src/utils/model/providers.ts'

function withSelection<T>(
  provider: string,
  model: string,
  operation: () => T,
  environment: Readonly<Record<string, string | undefined>> = {},
): T {
  return runWithStartupProviderSelection(
    { provider, model, environment },
    operation,
  )
}

test('model helpers consume the immutable canonical startup selection', () => {
  withSelection('grok', 'grok-build-0.1', () => {
    expect(getSelectedProviderModel()).toBe('grok-build-0.1')
    expect(getDefaultMainLoopModelSetting()).toBe('grok-build-0.1')
    expect(getDefaultMainLoopModel()).toBe('grok-build-0.1')
  })
})

test('xAI helper projections stay aligned with the canonical provider default', () => {
  const providerDefault = BUILT_IN_PROVIDER_DEFAULT_MODELS.grok
  expect(providerDefault).toBe('grok-4.6')
  withSelection('grok', providerDefault, () => {
    expect({
      main: getDefaultMainLoopModel(),
      setting: getDefaultMainLoopModelSetting(),
      smallFast: getSmallFastModel(),
      opus: getDefaultOpusModel(),
      sonnet: getDefaultSonnetModel(),
      haiku: getDefaultHaikuModel(),
    }).toEqual({
      main: providerDefault,
      setting: providerDefault,
      smallFast: providerDefault,
      opus: providerDefault,
      sonnet: providerDefault,
      haiku: providerDefault,
    })
    expect(getPublicModelDisplayName(providerDefault)).toBe('Grok 4.6')
  })
})

test('post-capture ambient env mutation cannot redirect model or environment authority', async () => {
  const original = process.env.OPENAI_BASE_URL
  try {
    await withSelection(
      'grok',
      'grok-canonical',
      async () => {
        process.env.OPENAI_BASE_URL = 'https://ambient.invalid/v1'
        await Promise.resolve()
        expect(getSelectedProviderModel()).toBe('grok-canonical')
        expect(getDefaultMainLoopModel()).toBe('grok-canonical')
        expect(getSelectedProviderEnvironment().OPENAI_BASE_URL).toBe(
          'https://captured.example/v1',
        )
      },
      { OPENAI_BASE_URL: 'https://captured.example/v1' },
    )
  } finally {
    if (original === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = original
  }
})
