import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRuntimeOpenAiCodeCredentials } from '../../../src/services/api/providerConfig.ts'

afterEach(() => {
  mock.restore()
})

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

test('runtime credential resolution honors explicit env over stored secure-storage tokens', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agenc-providerCode-explicit-auth-'))
  const authPath = join(tempDir, 'auth.json')

  writeFileSync(
    authPath,
    JSON.stringify({
      openai_api_key: makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_explicit_auth_json',
        },
      }),
    }),
    'utf8',
  )

  try {
    const credentials = resolveRuntimeOpenAiCodeCredentials({
      env: {
        PROVIDER_CODE_API_KEY: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_explicit_env',
          },
        }),
        PROVIDER_CODE_AUTH_JSON_PATH: authPath,
      } as NodeJS.ProcessEnv,
      storedCredentials: {
        apiKey: 'stored-api-key',
        accessToken: 'stored-access-token',
        accountId: 'acct_stored',
      },
    })

    expect(credentials.source).toBe('env')
    expect(credentials.accountId).toBe('acct_explicit_env')
    expect(credentials.apiKey).not.toBe('stored-api-key')
  } finally {
    rmSync(tempDir, { force: true, recursive: true })
  }
})

test('runtime credential resolution ignores retired auth.json path inputs', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agenc-providerCode-missing-auth-'))
  const authPath = join(tempDir, 'missing-auth.json')

  try {
    const credentials = resolveRuntimeOpenAiCodeCredentials({
      env: {
        PROVIDER_CODE_AUTH_JSON_PATH: authPath,
      } as NodeJS.ProcessEnv,
      storedCredentials: {
        apiKey: 'stored-api-key',
        accessToken: 'stored-access-token',
        accountId: 'acct_stored',
      },
    })

    expect(credentials.source).toBe('secure-storage')
    expect(credentials.apiKey).toBe('stored-api-key')
    expect(credentials.accountId).toBe('acct_stored')
  } finally {
    rmSync(tempDir, { force: true, recursive: true })
  }
})

test('runtime credential resolution avoids sync secure-storage reads when async credentials are provided', async () => {
  let syncReadCalled = false

  mock.module('../../../src/utils/agencCredentials.ts', () => ({
    isAgencRefreshFailureCoolingDown: () => false,
    readAgencCredentials: () => {
      syncReadCalled = true
      throw new Error('sync secure-storage read should not run in runtime resolution')
    },
  }))

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { resolveRuntimeOpenAiCodeCredentials } = await import(
    '../../../src/services/api/providerConfig.ts?runtime-no-sync-secure-storage'
  )

  const credentials = resolveRuntimeOpenAiCodeCredentials({
    env: {} as NodeJS.ProcessEnv,
    storedCredentials: {
      accessToken: 'stored-access-token',
      accountId: 'acct_stored',
    },
  })

  expect(syncReadCalled).toBe(false)
  expect(credentials.source).toBe('secure-storage')
  expect(credentials.apiKey).toBe('stored-access-token')
  expect(credentials.accountId).toBe('acct_stored')
})
