import { afterEach, describe, expect, test, vi } from 'vitest'
import { snapshotProviderEnvironment } from '../../src/llm/provider-options.js'
import type { ProviderAuthReadContext } from '../../src/utils/auth.js'

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

function fastModeContext(
  environment: Readonly<Record<string, string | undefined>> = Object.freeze({}),
): ProviderAuthReadContext {
  return Object.freeze({
    home: Object.freeze({ path: '/tmp/agenc-fast-mode-test-home' }) as never,
    environment,
    provider: 'anthropic',
  })
}

function installCommonMocks(options?: {
  cachedEnabled?: boolean
  apiKey?: string | null
  oauthToken?: string | null
  hasProfileScope?: boolean
  axiosReject?: boolean
}) {
  const axiosClient = {
    defaults: {},
    get: options?.axiosReject
      ? async () => {
          throw new Error('network fail')
        }
      : async () => ({ data: { enabled: false, disabled_reason: 'preference' } }),
  }
  vi.doMock(axiosModulePath, () => ({
    default: {
      create: () => axiosClient,
      isAxiosError: () => false,
    },
  }))

  vi.doMock(oauthModulePath, () => ({
    fileSuffixForOauthConfig: () => '',
    getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
    OAUTH_BETA_HEADER: 'test-beta',
  }))

  vi.doMock(bootstrapStateModulePath, () => ({
    getIsNonInteractiveSession: () => false,
    getKairosActive: () => false,
    preferThirdPartyAuthentication: () => false,
  }))

  vi.doMock(authModulePath, () => ({
    getAnthropicApiKeyWithSourceForContext: () => ({
      key: options?.apiKey ?? null,
      source: options?.apiKey ? 'ANTHROPIC_API_KEY' : 'none',
    }),
    getAgenCAIOAuthTokens: () =>
      options?.oauthToken ? { accessToken: options.oauthToken } : null,
    handleOAuth401Error: async () => {},
    hasProfileScope: () => options?.hasProfileScope ?? false,
  }))

  vi.doMock(bundledModeModulePath, () => ({
    isInBundledMode: () => true,
  }))

  vi.doMock(configModulePath, () => ({
    getRuntimeState: () => ({
      penguinModeOrgEnabled: options?.cachedEnabled === true,
    }),
    updateRuntimeState: (updater: (current: Record<string, unknown>) => Record<string, unknown>) =>
      updater({ penguinModeOrgEnabled: options?.cachedEnabled === true }),
  }))

  vi.doMock(debugModulePath, () => ({
    logForDebugging: () => {},
  }))

  vi.doMock(envUtilsModulePath, async importOriginal => ({
    ...(await importOriginal<typeof import('../../src/utils/envUtils.js')>()),
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
    getSelectedProviderEnvironment: () => Object.freeze({}),
    getSelectedProviderName: () => 'anthropic',
  }))

  vi.doMock(privacyLevelModulePath, () => ({
    isEssentialTrafficOnly: () => false,
  }))

  vi.doMock(settingsModulePath, () => ({
    getExecutionAuthoritySettings: () => ({ fastMode: true }),
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
      getFastModeUnavailableReasonForContext,
    } = await importFreshFastModeModule()
    const context = fastModeContext()

    resolveFastModeStatusFromCache(context)

    expect(getFastModeUnavailableReasonForContext(context)).toBe(
      'Fast mode is currently unavailable',
    )
  })

  test('prefetchFastModeStatus without auth does not force-enable from USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    installCommonMocks({ cachedEnabled: false, apiKey: null, oauthToken: null })

    const {
      prefetchFastModeStatus,
      getFastModeUnavailableReasonForContext,
    } = await importFreshFastModeModule()
    const context = fastModeContext()

    await prefetchFastModeStatus(context)

    expect(getFastModeUnavailableReasonForContext(context)).toBe(
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
      getFastModeUnavailableReasonForContext,
    } = await importFreshFastModeModule()
    const context = fastModeContext()

    await prefetchFastModeStatus(context)

    expect(getFastModeUnavailableReasonForContext(context)).toBe(
      'Fast mode unavailable due to network connectivity issues',
    )
  })

  test('uses the captured fast-mode flags after the source and process environments mutate', async () => {
    installCommonMocks()
    const sourceEnvironment: Record<string, string | undefined> = {
      AGENC_DISABLE_FAST_MODE: '0',
      AGENC_SKIP_FAST_MODE_NETWORK_ERRORS: '1',
    }
    const capturedEnvironment = snapshotProviderEnvironment(sourceEnvironment)
    const context = fastModeContext(capturedEnvironment)
    const { isFastModeEnabledForContext } = await importFreshFastModeModule()

    sourceEnvironment.AGENC_DISABLE_FAST_MODE = '1'
    process.env.AGENC_DISABLE_FAST_MODE = '1'

    expect(capturedEnvironment).toMatchObject({
      AGENC_DISABLE_FAST_MODE: '0',
      AGENC_SKIP_FAST_MODE_NETWORK_ERRORS: '1',
    })
    expect(isFastModeEnabledForContext(context)).toBe(true)
  })
})
