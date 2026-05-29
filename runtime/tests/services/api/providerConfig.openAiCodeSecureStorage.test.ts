import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realOs from 'node:os'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('resolveProviderCodeApiCredentials with secure storage', () => {
  afterEach(() => {
    mock.restore()
  })

  test('loads ProviderCode credentials from AgenC secure storage', async () => {
    mock.module('../../../src/utils/agencCredentials.ts', () => ({
      isAgencRefreshFailureCoolingDown: () => false,
      readAgencCredentials: () => ({
        apiKey: 'providerCode-api-key-token',
        accessToken: 'header.payload.signature',
        accountId: 'acct_secure',
      }),
    }))

    // @ts-expect-error cache-busting query string for Bun module mocks
    const { resolveProviderCodeApiCredentials } = await import(
      '../../../src/services/api/providerConfig.ts?providerCode-secure-storage'
    )

    const credentials = resolveProviderCodeApiCredentials({} as NodeJS.ProcessEnv)
    expect(credentials.apiKey).toBe('providerCode-api-key-token')
    expect(credentials.accountId).toBe('acct_secure')
    expect(credentials.source).toBe('secure-storage')
  })

  test('prefers explicit env credentials over secure storage', async () => {
    mock.module('../../../src/utils/agencCredentials.ts', () => ({
      isAgencRefreshFailureCoolingDown: () => false,
      readAgencCredentials: () => ({
        accessToken: 'stored-token',
        accountId: 'acct_stored',
      }),
    }))

    // @ts-expect-error cache-busting query string for Bun module mocks
    const { resolveProviderCodeApiCredentials } = await import(
      '../../../src/services/api/providerConfig.ts?providerCode-env-precedence'
    )

    const credentials = resolveProviderCodeApiCredentials({
      PROVIDER_CODE_API_KEY: 'env-token',
      CHATGPT_ACCOUNT_ID: 'acct_env',
    } as NodeJS.ProcessEnv)

    expect(credentials.apiKey).toBe('env-token')
    expect(credentials.accountId).toBe('acct_env')
    expect(credentials.source).toBe('env')
  })

  test('parses nested chatgpt_account_id from a PROVIDER_CODE_API_KEY JWT', async () => {
    mock.module('../../../src/utils/agencCredentials.ts', () => ({
      isAgencRefreshFailureCoolingDown: () => false,
      readAgencCredentials: () => undefined,
    }))

    // @ts-expect-error cache-busting query string for Bun module mocks
    const { resolveProviderCodeApiCredentials } = await import(
      '../../../src/services/api/providerConfig.ts?providerCode-env-nested-account'
    )

    const credentials = resolveProviderCodeApiCredentials({
      PROVIDER_CODE_API_KEY: makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_nested_env',
        },
      }),
    } as NodeJS.ProcessEnv)

    expect(credentials.accountId).toBe('acct_nested_env')
    expect(credentials.source).toBe('env')
  })

  test('parses nested chatgpt_account_id from auth.json tokens', async () => {
    mock.module('../../../src/utils/agencCredentials.ts', () => ({
      isAgencRefreshFailureCoolingDown: () => false,
      readAgencCredentials: () => undefined,
    }))

    const tempDir = mkdtempSync(join(tmpdir(), 'agenc-providerCode-auth-'))
    const authPath = join(tempDir, 'auth.json')

    writeFileSync(
      authPath,
      JSON.stringify({
        openai_api_key: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_nested_auth_json',
          },
        }),
      }),
      'utf8',
    )

    try {
      // @ts-expect-error cache-busting query string for Bun module mocks
      const { resolveProviderCodeApiCredentials } = await import(
        '../../../src/services/api/providerConfig.ts?providerCode-auth-json-nested-account'
      )

      const credentials = resolveProviderCodeApiCredentials({
        PROVIDER_CODE_AUTH_JSON_PATH: authPath,
      } as NodeJS.ProcessEnv)

      expect(credentials.accountId).toBe('acct_nested_auth_json')
      expect(credentials.source).toBe('auth.json')
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
  })

  test('does not read default auth.json when secure storage already has ProviderCode credentials', async () => {
    mock.module('../../../src/utils/agencCredentials.ts', () => ({
      isAgencRefreshFailureCoolingDown: () => false,
      readAgencCredentials: () => ({
        apiKey: 'providerCode-api-key-token',
        accessToken: 'header.payload.signature',
        accountId: 'acct_secure',
      }),
    }))

    // @ts-expect-error cache-busting query string for Bun module mocks
    const { resolveProviderCodeApiCredentials } = await import(
      '../../../src/services/api/providerConfig.ts?providerCode-secure-storage-no-auth-io'
    )

    const credentials = resolveProviderCodeApiCredentials({} as NodeJS.ProcessEnv)
    expect(credentials.apiKey).toBe('providerCode-api-key-token')
    expect(credentials.accountId).toBe('acct_secure')
    expect(credentials.source).toBe('secure-storage')
  })

  test('falls back to the default auth.json when stored ProviderCode refresh is cooling down', async () => {
    const tempHomeDir = mkdtempSync(join(tmpdir(), 'agenc-providerCode-home-'))
    const authJson = JSON.stringify({
      openai_api_key: makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_auth_json',
        },
      }),
    })
    mkdirSync(join(tempHomeDir, '.providerCode'), { recursive: true })
    writeFileSync(join(tempHomeDir, '.providerCode', 'auth.json'), authJson, 'utf8')

    mock.module('node:os', () => ({
      ...realOs,
      homedir: () => tempHomeDir,
    }))

    mock.module('../../../src/utils/agencCredentials.ts', () => ({
      isAgencRefreshFailureCoolingDown: () => true,
      readAgencCredentials: () => ({
        accessToken: 'stored-token',
        refreshToken: 'refresh-stored',
        accountId: 'acct_stored',
        lastRefreshFailureAt: Date.now(),
      }),
    }))

    // @ts-expect-error cache-busting query string for Bun module mocks
    const { resolveProviderCodeApiCredentials } = await import(
      '../../../src/services/api/providerConfig.ts?providerCode-refresh-cooldown-fallback'
    )

    try {
      const credentials = resolveProviderCodeApiCredentials({} as NodeJS.ProcessEnv)
      expect(credentials.source).toBe('auth.json')
      expect(credentials.accountId).toBe('acct_auth_json')
      expect(credentials.apiKey).not.toBe('stored-token')
    } finally {
      rmSync(tempHomeDir, { force: true, recursive: true })
    }
  })

  test('preserves the stored account id when auth.json fallback lacks one', async () => {
    const tempHomeDir = mkdtempSync(join(tmpdir(), 'agenc-providerCode-home-'))
    const authJson = JSON.stringify({
      openai_api_key: 'auth-json-access-token',
    })
    mkdirSync(join(tempHomeDir, '.providerCode'), { recursive: true })
    writeFileSync(join(tempHomeDir, '.providerCode', 'auth.json'), authJson, 'utf8')

    mock.module('node:os', () => ({
      ...realOs,
      homedir: () => tempHomeDir,
    }))

    mock.module('../../../src/utils/agencCredentials.ts', () => ({
      isAgencRefreshFailureCoolingDown: () => true,
      readAgencCredentials: () => ({
        accessToken: 'stored-token',
        refreshToken: 'refresh-stored',
        accountId: 'acct_stored',
        lastRefreshFailureAt: Date.now(),
      }),
    }))

    // @ts-expect-error cache-busting query string for Bun module mocks
    const { resolveProviderCodeApiCredentials } = await import(
      '../../../src/services/api/providerConfig.ts?providerCode-refresh-cooldown-account-id-fallback'
    )

    try {
      const credentials = resolveProviderCodeApiCredentials({} as NodeJS.ProcessEnv)
      expect(credentials.source).toBe('auth.json')
      expect(credentials.apiKey).toBe('auth-json-access-token')
      expect(credentials.accountId).toBe('acct_stored')
    } finally {
      rmSync(tempHomeDir, { force: true, recursive: true })
    }
  })
})
