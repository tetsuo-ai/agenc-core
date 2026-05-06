// @ts-nocheck
import { afterEach, expect, mock, test } from 'bun:test'

afterEach(() => {
  mock.restore()
})

async function importFreshEffortModule(options: {
  provider: 'agenc' | 'openai'
  supportsCodexReasoningEffort: boolean
}) {
  mock.module('./model/providers.js', () => ({
    getAPIProvider: () => options.provider,
  }))
  mock.module('./model/modelSupportOverrides.js', () => ({
    get3PModelCapabilityOverride: () => undefined,
  }))
  mock.module('../services/api/providerConfig.js', () => ({
    supportsCodexReasoningEffort: () => options.supportsCodexReasoningEffort,
  }))

  return import(`./effort.js?ts=${Date.now()}-${Math.random()}`)
}

test('gpt-5.4 on the ChatGPT Agenc backend supports effort selection', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'agenc',
      supportsCodexReasoningEffort: true,
    })

  expect(modelSupportsEffort('gpt-5.4')).toBe(true)
  expect(getAvailableEffortLevels('gpt-5.4')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
})

test('gpt-5.4 on the openai provider still supports effort selection', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'openai',
      supportsCodexReasoningEffort: true,
    })

  expect(modelSupportsEffort('gpt-5.4')).toBe(true)
  expect(getAvailableEffortLevels('gpt-5.4')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
})

test('gpt-5.3-codex-spark stays without effort controls', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'agenc',
      supportsCodexReasoningEffort: false,
    })

  expect(modelSupportsEffort('gpt-5.3-codex-spark')).toBe(false)
  expect(getAvailableEffortLevels('gpt-5.3-codex-spark')).toEqual([])
})
