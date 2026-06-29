import { afterEach, describe, expect, test, vi } from 'vitest'

const originalEnv = { ...process.env }
const authModulePath = '../../src/utils/auth.js'
const configModulePath = '../../src/utils/config.js'
const cwdModulePath = '../../src/utils/cwd.js'
const envModulePath = '../../src/utils/env.js'
const envUtilsModulePath = '../../src/utils/envUtils.js'
const execaModulePath = 'execa'

async function importFreshUserModule() {
  vi.resetModules()
  return import('../../src/utils/user.ts')
}

function installCommonMocks(options?: {
  oauthEmail?: string
  gitEmail?: string
}) {
  // NOTE: Do NOT mock ../bootstrap/state.js here.
  // Mocking state.js leaks getSessionId = () => 'session-test' into
  // every other test file that imports state.js.
  // The dynamic import (importFreshUserModule) will use the real state.js,
  // which is fine — these tests only assert email, not sessionId.

  vi.doMock(authModulePath, () => ({
    getOauthAccountInfo: () =>
      options?.oauthEmail
        ? {
            emailAddress: options.oauthEmail,
            organizationUuid: 'org-test',
            accountUuid: 'acct-test',
          }
        : undefined,
    getRateLimitTier: () => null,
    getSubscriptionType: () => null,
  }))

  vi.doMock(configModulePath, () => ({
    getGlobalConfig: () => ({}),
    getOrCreateUserID: () => 'device-test',
  }))

  vi.doMock(cwdModulePath, () => ({
    getCwd: () => 'C:\\repo',
  }))

  vi.doMock(envModulePath, () => ({
    env: { platform: 'windows' },
    getHostPlatform: () => 'windows',
  }))

  vi.doMock(envUtilsModulePath, () => ({
    isEnvTruthy: (value: string | undefined) =>
      !!value && value !== '0' && value.toLowerCase() !== 'false',
  }))

  vi.doMock(execaModulePath, () => ({
    execa: async () => ({
      exitCode: options?.gitEmail ? 0 : 1,
      stdout: options?.gitEmail ?? '',
    }),
    execaSync: () => ({
      exitCode: options?.gitEmail ? 0 : 1,
      stdout: options?.gitEmail ?? '',
    }),
  }))
}

afterEach(() => {
  vi.doUnmock(authModulePath)
  vi.doUnmock(configModulePath)
  vi.doUnmock(cwdModulePath)
  vi.doUnmock(envModulePath)
  vi.doUnmock(envUtilsModulePath)
  vi.doUnmock(execaModulePath)
  vi.clearAllMocks()
  vi.resetModules()
  process.env = { ...originalEnv }
  delete (globalThis as Record<string, unknown>).MACRO
})

describe('user email fallbacks', () => {
  test('getCoreUserData does not synthesize provider email from COO_CREATOR', async () => {
    process.env.USER_TYPE = 'ant'
    process.env.COO_CREATOR = 'alice'
    ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }

    installCommonMocks()

    const { getCoreUserData } = await importFreshUserModule()
    const result = getCoreUserData()

    expect(result.email).toBeUndefined()
  })

  test('initUser falls back to git email when oauth email is missing', async () => {
    process.env.USER_TYPE = 'ant'
    process.env.COO_CREATOR = 'alice'
    ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }

    installCommonMocks({ gitEmail: 'git@example.com' })

    const { initUser, getCoreUserData } = await importFreshUserModule()
    await initUser()

    const result = getCoreUserData()
    expect(result.email).toBe('git@example.com')
  })
})
