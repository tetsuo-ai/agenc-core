import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import type { EnvSnapshot } from '../../src/config/env.ts'
import {
  getGeminiProjectIdHint,
  mayHaveGeminiAdcCredentials,
  resolveGeminiCredential,
} from '../../src/utils/geminiAuth.ts'

const existingFilePath = fileURLToPath(import.meta.url)
const missingPlatformHome = '/agenc-test/missing-platform-home'

function environment(values: EnvSnapshot = {}): EnvSnapshot {
  return Object.freeze({ ...values })
}

describe('resolveGeminiCredential', () => {
  test('prefers GEMINI_API_KEY over other captured Gemini auth inputs', async () => {
    await expect(resolveGeminiCredential(environment({
      GEMINI_API_KEY: 'gem-key',
      GOOGLE_API_KEY: 'google-key',
      GEMINI_ACCESS_TOKEN: 'token-123',
    }))).resolves.toEqual({
      kind: 'api-key',
      credential: 'gem-key',
    })
  })

  test('uses only the captured access token and canonical project hint', async () => {
    await expect(resolveGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'access-token',
      GEMINI_ACCESS_TOKEN: 'token-123',
      GEMINI_PROJECT_ID: 'test-project',
    }))).resolves.toEqual({
      kind: 'access-token',
      credential: 'token-123',
      projectId: 'test-project',
    })
  })

  test('falls back to ADC when the captured environment selects it', async () => {
    const fakeAuth = {
      async getClient() {
        return {
          async getAccessToken() {
            return { token: 'adc-token' }
          },
        }
      },
      async getProjectId() {
        return 'adc-project'
      },
    }

    await expect(resolveGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'adc',
      GOOGLE_APPLICATION_CREDENTIALS: existingFilePath,
    }), {
      createGoogleAuth: async () => fakeAuth,
      platformHome: missingPlatformHome,
    })).resolves.toEqual({
      kind: 'adc',
      credential: 'adc-token',
      projectId: 'adc-project',
    })
  })

  test('returns none when the captured environment has no auth source', async () => {
    await expect(resolveGeminiCredential(environment(), {
      platformHome: missingPlatformHome,
    })).resolves.toEqual({ kind: 'none' })
  })

  test('access-token mode does not silently fall back to ADC', async () => {
    const fakeAuth = {
      async getClient() {
        return {
          async getAccessToken() {
            return { token: 'adc-token' }
          },
        }
      },
    }

    await expect(resolveGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'access-token',
      GOOGLE_APPLICATION_CREDENTIALS: existingFilePath,
    }), {
      createGoogleAuth: async () => fakeAuth,
      platformHome: missingPlatformHome,
    })).resolves.toEqual({ kind: 'none' })
  })

  test('adc mode ignores a captured access token', async () => {
    const fakeAuth = {
      async getClient() {
        return {
          async getAccessToken() {
            return { token: 'adc-token' }
          },
        }
      },
      async getProjectId() {
        return 'adc-project'
      },
    }

    await expect(resolveGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'adc',
      GEMINI_ACCESS_TOKEN: 'token-123',
      GOOGLE_APPLICATION_CREDENTIALS: existingFilePath,
    }), {
      createGoogleAuth: async () => fakeAuth,
      platformHome: missingPlatformHome,
    })).resolves.toEqual({
      kind: 'adc',
      credential: 'adc-token',
      projectId: 'adc-project',
    })
  })
})

describe('Gemini auth helpers', () => {
  test('uses the AgenC-specific project id before the documented Google alias', () => {
    expect(getGeminiProjectIdHint(environment({
      GEMINI_PROJECT_ID: 'gemini-project',
      GOOGLE_CLOUD_PROJECT: 'google-project',
    }))).toBe('gemini-project')
    expect(getGeminiProjectIdHint(environment({
      GOOGLE_CLOUD_PROJECT: 'google-project',
    }))).toBe('google-project')
  })

  test('does not accept undocumented Google project aliases', () => {
    expect(getGeminiProjectIdHint(environment({
      GCLOUD_PROJECT: 'retired-a',
      GOOGLE_PROJECT_ID: 'retired-b',
    }))).toBeUndefined()
  })

  test('only treats paths from the captured ADC context as valid hints', () => {
    expect(mayHaveGeminiAdcCredentials(environment({
      GOOGLE_APPLICATION_CREDENTIALS: existingFilePath,
    }), missingPlatformHome)).toBe(true)

    expect(mayHaveGeminiAdcCredentials(environment({
      GOOGLE_APPLICATION_CREDENTIALS: `${existingFilePath}.missing`,
    }), missingPlatformHome)).toBe(false)
  })
})
