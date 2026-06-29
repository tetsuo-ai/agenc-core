import { afterEach, expect, test, vi } from 'vitest'

const providersModulePath = '../../src/utils/model/providers.js'
const modelSupportOverridesModulePath =
  '../../src/utils/model/modelSupportOverrides.js'

afterEach(() => {
  vi.doUnmock(providersModulePath)
  vi.doUnmock(modelSupportOverridesModulePath)
  vi.clearAllMocks()
  vi.resetModules()
})

async function importFreshEffortModule(options: {
  provider: 'agenc' | 'openai'
}) {
  vi.resetModules()
  vi.doMock(providersModulePath, () => ({
    getAPIProvider: () => options.provider,
    isFirstPartyAnthropicBaseUrl: () => options.provider === 'agenc',
    isFirstPartyproviderBaseUrl: () => options.provider === 'agenc',
    isGithubNativeAnthropicMode: () => false,
    isGithubNativeproviderMode: () => false,
    usesAnthropicAccountFlow: () => false,
  }))
  vi.doMock(modelSupportOverridesModulePath, () => ({
    get3PModelCapabilityOverride: () => undefined,
  }))

  return import('../../src/utils/effort.ts')
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
