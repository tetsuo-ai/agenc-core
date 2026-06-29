import { afterEach, describe, expect, test, vi } from 'vitest'

const originalEnv = { ...process.env }
const axiosModulePath = 'axios'
const oauthModulePath = 'src/constants/oauth.js'
const bootstrapStateModulePath = '../../src/bootstrap/state.js'
const authModulePath = '../../src/utils/auth.js'
const bundledModeModulePath = '../../src/utils/bundledMode.js'
const configModulePath = '../../src/utils/config.js'
const debugModulePath = 'src/utils/debug.js'
const envUtilsModulePath = '../../src/utils/envUtils.js'
const modelModulePath = '../../src/utils/model/model.js'
const providersModulePath = '../../src/utils/model/providers.js'
const privacyLevelModulePath = '../../src/utils/privacyLevel.js'
const settingsModulePath = '../../src/utils/settings/settings.js'
const signalModulePath = '../../src/utils/signal.js'
const mockedModulePaths = [
  axiosModulePath,
  oauthModulePath,
  bootstrapStateModulePath,
  authModulePath,
  bundledModeModulePath,
  configModulePath,
  debugModulePath,
  envUtilsModulePath,
  modelModulePath,
  providersModulePath,
  privacyLevelModulePath,
  settingsModulePath,
  signalModulePath,
]

async function importFreshFastModeModule() {
  vi.resetModules()
  return import('../../src/utils/fastMode.ts')
}

function installCommonMocks(options?: {
  cachedEnabled?: boolean
  apiKey?: string | null
  oauthToken?: string | null
  hasProfileScope?: boolean
  axiosReject?: boolean
}) {
  vi.doMock(axiosModulePath, () => ({
    default: {
      get: options?.axiosReject
        ? async () => {
            throw new Error('network fail')
          }
        : async () => ({ data: { enabled: false, disabled_reason: 'preference' } }),
      isAxiosError: () => false,
    },
  }))

  vi.doMock(oauthModulePath, () => ({
    getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
    OAUTH_BETA_HEADER: 'test-beta',
  }))

  vi.doMock(bootstrapStateModulePath, () => ({
    getIsNonInteractiveSession: () => false,
    getKairosActive: () => false,
    preferThirdPartyAuthentication: () => false,
  }))

  vi.doMock(authModulePath, () => ({
    getAnthropicApiKey: () => options?.apiKey ?? null,
    getAgenCAIOAuthTokens: () =>
      options?.oauthToken ? { accessToken: options.oauthToken } : null,
    handleOAuth401Error: async () => {},
    hasProfileScope: () => options?.hasProfileScope ?? false,
  }))

  vi.doMock(bundledModeModulePath, () => ({
    isInBundledMode: () => true,
  }))

  vi.doMock(configModulePath, () => ({
    getGlobalConfig: () => ({
      penguinModeOrgEnabled: options?.cachedEnabled === true,
    }),
    saveGlobalConfig: (updater: (current: Record<string, unknown>) => Record<string, unknown>) =>
      updater({ penguinModeOrgEnabled: options?.cachedEnabled === true }),
  }))

  vi.doMock(debugModulePath, () => ({
    logForDebugging: () => {},
  }))

  vi.doMock(envUtilsModulePath, () => ({
    isEnvTruthy: (value: string | undefined) =>
      !!value && value !== '0' && value.toLowerCase() !== 'false',
  }))

  vi.doMock(modelModulePath, () => ({
    getDefaultMainLoopModelSetting: () => 'claude-sonnet-4-6',
    isOpus1mMergeEnabled: () => false,
    parseUserSpecifiedModel: (model: string) => model,
  }))

  vi.doMock(providersModulePath, () => ({
    getAPIProvider: () => 'firstParty',
  }))

  vi.doMock(privacyLevelModulePath, () => ({
    isEssentialTrafficOnly: () => false,
  }))

  vi.doMock(settingsModulePath, () => ({
    getInitialSettings: () => ({ fastMode: true }),
    getSettingsForSource: () => ({}),
    updateSettingsForSource: () => {},
  }))

  vi.doMock(signalModulePath, () => ({
    createSignal: () => {
      const subscribe = () => () => {}
      const emit = () => {}
      return { subscribe, emit }
    },
  }))
}

afterEach(() => {
  for (const modulePath of mockedModulePaths) {
    vi.doUnmock(modulePath)
  }
  vi.clearAllMocks()
  vi.resetModules()
  process.env = { ...originalEnv }
})

describe('fastMode ant-only fallback cleanup', () => {
  test('resolveFastModeStatusFromCache does not force-enable from USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    installCommonMocks({ cachedEnabled: false })

    const {
      resolveFastModeStatusFromCache,
      getFastModeUnavailableReason,
    } = await importFreshFastModeModule()

    resolveFastModeStatusFromCache()

    expect(getFastModeUnavailableReason()).toBe(
      'Fast mode is currently unavailable',
    )
  })

  test('prefetchFastModeStatus without auth does not force-enable from USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    installCommonMocks({ cachedEnabled: false, apiKey: null, oauthToken: null })

    const {
      prefetchFastModeStatus,
      getFastModeUnavailableReason,
    } = await importFreshFastModeModule()

    await prefetchFastModeStatus()

    expect(getFastModeUnavailableReason()).toBe(
      'Fast mode has been disabled by your organization',
    )
  })

  test('prefetchFastModeStatus network failure does not force-enable from USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    installCommonMocks({
      cachedEnabled: false,
      apiKey: 'test-key',
      axiosReject: true,
    })

    const {
      prefetchFastModeStatus,
      getFastModeUnavailableReason,
    } = await importFreshFastModeModule()

    await prefetchFastModeStatus()

    expect(getFastModeUnavailableReason()).toBe(
      'Fast mode unavailable due to network connectivity issues',
    )
  })
})
