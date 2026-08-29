import { afterEach, expect, test, vi } from 'vitest'

const providersModulePath = '../../src/utils/model/providers.js'
const modelSupportOverridesModulePath =
  '../../src/utils/model/modelSupportOverrides.js'
const authModulePath = '../../src/utils/auth.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock(providersModulePath)
  vi.doUnmock(modelSupportOverridesModulePath)
  vi.doUnmock(authModulePath)
  vi.clearAllMocks()
  vi.resetModules()
})

async function importFreshEffortModule(options: {
  provider: 'agenc' | 'openai' | 'xai'
}) {
  vi.resetModules()
  vi.doMock(providersModulePath, () => ({
    getAPIProvider: (provider?: string) => {
      if (provider === 'openai' || provider === 'agenc') return provider
      if (provider === 'grok' || provider === 'xai') return 'xai'
      if (provider === 'anthropic') return 'firstParty'
      return options.provider
    },
    isFirstPartyAnthropicBaseUrl: () => options.provider === 'agenc',
    isFirstPartyproviderBaseUrl: () => options.provider === 'agenc',
    isGithubNativeAnthropicMode: () => false,
    isGithubNativeproviderMode: () => false,
    usesAnthropicAccountFlow: () => false,
  }))
  vi.doMock(modelSupportOverridesModulePath, () => ({
    get3PModelCapabilityOverride: () => undefined,
  }))
  vi.doMock(authModulePath, () => ({
    getSubscriptionType: () => null,
    getSubscriptionTypeForContext: (context: {
      environment: Record<string, string | undefined>
    }) => context.environment.TEST_SUBSCRIPTION ?? null,
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

test('explicit effort context wins over ambient provider and subscription state', async () => {
  const {
    getAvailableEffortLevelsForContext,
    getDefaultEffortForModelForContext,
    modelSupportsEffortForContext,
  } = await importFreshEffortModule({ provider: 'xai' })
  vi.stubEnv('USER_TYPE', 'ant')
  const context = {
    home: {},
    environment: { TEST_SUBSCRIPTION: 'pro' },
    provider: 'openai',
  } as never

  expect(modelSupportsEffortForContext('gpt-5.4', context)).toBe(true)
  expect(getAvailableEffortLevelsForContext('gpt-5.4', context)).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  expect(getDefaultEffortForModelForContext('opus-4-8', context)).toBe(
    'medium',
  )
})

test('gpt-5.3-providercode-spark stays without effort controls', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'agenc',
    })

  expect(modelSupportsEffort('gpt-5.3-providercode-spark')).toBe(false)
  expect(getAvailableEffortLevels('gpt-5.3-providercode-spark')).toEqual([])
})

test('grok reasoning models expose their exact catalog effort levels', async () => {
  const {
    getAvailableEffortLevels,
    modelSupportsEffort,
    resolveAppliedEffort,
    toPersistableEffort,
  } =
    await importFreshEffortModule({
      provider: 'xai',
    })

  expect(modelSupportsEffort('grok-4.6')).toBe(true)
  expect(modelSupportsEffort('grok-4.5')).toBe(true)
  expect(modelSupportsEffort('grok-4.3')).toBe(true)
  expect(getAvailableEffortLevels('grok-4.6')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  expect(getAvailableEffortLevels('grok-4.5')).toEqual([
    'low',
    'medium',
    'high',
  ])
  expect(getAvailableEffortLevels('grok-4.3')).toEqual([
    'low',
    'medium',
    'high',
  ])

  expect(toPersistableEffort('xhigh')).toBe('max')
  expect(resolveAppliedEffort('grok-4.6', 'max')).toBe('xhigh')
  expect(resolveAppliedEffort('grok-4.5', 'max')).toBe('high')
})

test('grok models without catalog reasoning levels do not expose effort', async () => {
  const { modelSupportsEffort } = await importFreshEffortModule({
    provider: 'agenc',
  })

  expect(modelSupportsEffort('grok-composer-2.5-fast')).toBe(false)
})
