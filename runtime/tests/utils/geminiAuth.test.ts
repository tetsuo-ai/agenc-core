import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import type { EnvSnapshot } from '../../src/config/env.ts'
import {
  getGeminiAdcCredentialPaths,
  getGeminiAuthMode,
  getGeminiProjectIdHint,
  mayHaveGeminiAdcCredentials,
  resolveGeminiCredential,
  resolveGeminiCredentialPlan,
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
      source: 'GEMINI_API_KEY',
    })
  })

  test('an explicit factory key wins every valid captured mode', async () => {
    await expect(resolveGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'adc',
      GEMINI_API_KEY: 'environment-key',
      GEMINI_ACCESS_TOKEN: 'environment-token',
    }), {
      apiKey: 'factory-key',
      platformHome: missingPlatformHome,
    })).resolves.toEqual({
      kind: 'api-key',
      credential: 'factory-key',
      source: 'factory',
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
      source: 'GEMINI_ACCESS_TOKEN',
    })
  })

  test('falls back to ADC when the captured environment selects it', async () => {
    const fakeAuth = {
      async getClient() {
        return {
          async getAccessToken() {
            return { token: 'adc-token' }
          },
          projectId: 'adc-project',
        }
      },
    }

    let selectedPath: string | undefined

    await expect(resolveGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'adc',
      GOOGLE_APPLICATION_CREDENTIALS: existingFilePath,
    }), {
      createGoogleAuth: async input => {
        selectedPath = input.credentialPath
        return fakeAuth
      },
      platformHome: missingPlatformHome,
    })).resolves.toEqual({
      kind: 'adc',
      credential: 'adc-token',
      projectId: 'adc-project',
      source: 'GOOGLE_APPLICATION_CREDENTIALS',
    })
    expect(selectedPath).toBe(existingFilePath)
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
          projectId: 'adc-project',
        }
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
      source: 'GOOGLE_APPLICATION_CREDENTIALS',
    })
  })

  test('does not hide invalid auth modes behind usable credentials', async () => {
    await expect(resolveGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'system',
      GEMINI_API_KEY: 'gem-key',
    }))).rejects.toThrow(
      'Invalid GEMINI_AUTH_MODE "system"; expected api-key, access-token, or adc',
    )
  })

  test('surfaces a selected ADC file failure instead of treating it as no auth', async () => {
    const rootCause = new Error('bad credential document')
    const promise = resolveGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'adc',
      GOOGLE_APPLICATION_CREDENTIALS: existingFilePath,
    }), {
      createGoogleAuth: async () => {
        throw rootCause
      },
      platformHome: missingPlatformHome,
    })

    await expect(promise).rejects.toThrow(
      `Gemini ADC credential resolution failed for ${existingFilePath}`,
    )
    await promise.catch(error => {
      expect(error.cause).toBe(rootCause)
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

  test('an explicit missing ADC path does not fall through to a well-known file', () => {
    expect(resolveGeminiCredentialPlan(environment({
      GEMINI_AUTH_MODE: 'adc',
      GOOGLE_APPLICATION_CREDENTIALS: '/captured/missing.json',
      HOME: '/captured/home',
    }), {
      fileExists: path => path ===
        '/captured/home/.config/gcloud/application_default_credentials.json',
      platform: 'linux',
    })).toEqual({ kind: 'none' })
  })

  test('uses only the platform-appropriate captured well-known ADC path', () => {
    expect(getGeminiAdcCredentialPaths(environment({
      APPDATA: 'C:\\Captured\\AppData',
    }), '/captured/home', 'win32')).toEqual([
      'C:\\Captured\\AppData/gcloud/application_default_credentials.json',
    ])
    expect(getGeminiAdcCredentialPaths(environment({
      APPDATA: '/ignored/appdata',
    }), '/captured/home', 'linux')).toEqual([
      '/captured/home/.config/gcloud/application_default_credentials.json',
    ])
  })

  test('rejects unsupported modes after trimming and accepts documented modes case-insensitively', () => {
    expect(getGeminiAuthMode(environment({
      GEMINI_AUTH_MODE: ' ADC ',
    }))).toBe('adc')
    expect(() => getGeminiAuthMode(environment({
      GEMINI_AUTH_MODE: 'oauth',
    }))).toThrow('Invalid GEMINI_AUTH_MODE')
  })

  test('treats the literal undefined compatibility value as absent', () => {
    expect(resolveGeminiCredentialPlan(environment({
      GEMINI_API_KEY: 'undefined',
      GOOGLE_API_KEY: 'google-key',
    }))).toEqual({
      kind: 'api-key',
      credential: 'google-key',
      source: 'GOOGLE_API_KEY',
    })
  })
})
