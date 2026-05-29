import { afterEach, expect, mock, test } from 'bun:test'

afterEach(() => {
  mock.restore()
})

async function importFreshEffortModule(options: {
  provider: 'agenc' | 'openai'
}) {
  mock.module('../../src/utils/model/providers.js', () => ({
    getAPIProvider: () => options.provider,
    getAPIProviderForStatsig: () => options.provider,
    isFirstPartyAnthropicBaseUrl: () => options.provider === 'agenc',
    isFirstPartyproviderBaseUrl: () => options.provider === 'agenc',
    isGithubNativeAnthropicMode: () => false,
    isGithubNativeproviderMode: () => false,
    usesAnthropicAccountFlow: () => false,
  }))
  mock.module('../../src/utils/model/modelSupportOverrides.js', () => ({
    get3PModelCapabilityOverride: () => undefined,
  }))

  return import(`../../src/utils/effort.ts?ts=${Date.now()}-${Math.random()}`)
}

test('gpt-5.4 on the ChatGPT Agenc backend supports effort selection', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'agenc',
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
    })

  expect(modelSupportsEffort('gpt-5.4')).toBe(true)
  expect(getAvailableEffortLevels('gpt-5.4')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
})

test('gpt-5.3-providercode-spark stays without effort controls', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'agenc',
    })

  expect(modelSupportsEffort('gpt-5.3-providercode-spark')).toBe(false)
  expect(getAvailableEffortLevels('gpt-5.3-providercode-spark')).toEqual([])
})
