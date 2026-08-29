import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EnvSnapshot } from '../../src/config/env.ts'
import {
  getGeminiAuthMode,
  getGeminiProjectIdHint,
  materializeGeminiCredentialPlan,
  parseGeminiCredentialPlan,
  resolveGeminiCredentialPlan,
  type GeminiCredentialPlan,
} from '../../src/utils/geminiAuth.ts'

const existingFilePath = fileURLToPath(import.meta.url)
const missingPlatformHome = '/agenc-test/missing-platform-home'

function environment(values: EnvSnapshot = {}): EnvSnapshot {
  return Object.freeze({ ...values })
}

async function selectAndMaterializeGeminiCredential(
  env: EnvSnapshot,
  options: Parameters<typeof resolveGeminiCredentialPlan>[1] = {},
) {
  return materializeGeminiCredentialPlan(
    resolveGeminiCredentialPlan(env, options),
    options,
  )
}

describe('selectAndMaterializeGeminiCredential', () => {
  test('prefers GEMINI_API_KEY over other captured Gemini auth inputs', async () => {
    await expect(selectAndMaterializeGeminiCredential(environment({
      GEMINI_API_KEY: 'gem-key',
      GOOGLE_API_KEY: 'google-key',
      GEMINI_ACCESS_TOKEN: 'token-123',
    }))).resolves.toEqual({
      kind: 'api-key',
      credential: 'gem-key',
      source: 'GEMINI_API_KEY',
    })
  })

  test('forced ADC mode ignores an explicit factory API key', async () => {
    await expect(selectAndMaterializeGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'adc',
      GEMINI_API_KEY: 'environment-key',
      GEMINI_ACCESS_TOKEN: 'environment-token',
    }), {
      apiKey: 'factory-key',
      platformHome: missingPlatformHome,
    })).resolves.toEqual({
      kind: 'none',
      mode: 'adc',
      expected: 'adc',
      configuredPath:
        '/agenc-test/missing-platform-home/.config/gcloud/application_default_credentials.json',
    })
  })

  test('uses only the captured access token and canonical project hints', async () => {
    await expect(selectAndMaterializeGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'access-token',
      GEMINI_ACCESS_TOKEN: 'token-123',
      GEMINI_PROJECT_ID: 'test-project',
      GOOGLE_CLOUD_QUOTA_PROJECT: 'quota-project',
    }))).resolves.toEqual({
      kind: 'access-token',
      credential: 'token-123',
      projectId: 'test-project',
      quotaProjectId: 'quota-project',
      source: 'GEMINI_ACCESS_TOKEN',
    })
  })

  test('uses saved BYOK only as an API-key mode candidate', () => {
    expect(resolveGeminiCredentialPlan(environment(), {
      savedApiKey: 'saved-key',
      platformHome: missingPlatformHome,
    })).toEqual({
      kind: 'api-key',
      credential: 'saved-key',
      source: 'saved-byok',
    })

    expect(resolveGeminiCredentialPlan(environment({
      GEMINI_AUTH_MODE: 'adc',
      GOOGLE_APPLICATION_CREDENTIALS: '/captured/missing.json',
    }), {
      savedApiKey: 'stale-saved-key',
      fileExists: () => false,
      platformHome: missingPlatformHome,
    })).toEqual({
      kind: 'none',
      mode: 'adc',
      expected: 'adc',
      configuredPath: '/captured/missing.json',
    })
  })

  test('materializes the exact selected ADC file and client metadata', async () => {
    let selectedPath: string | undefined
    await expect(selectAndMaterializeGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'adc',
      GOOGLE_APPLICATION_CREDENTIALS: existingFilePath,
    }), {
      createGoogleAuthClient: async input => {
        selectedPath = input.credentialPath
        return {
          async getAccessToken() {
            return { token: 'adc-token' }
          },
          projectId: 'adc-project',
          quotaProjectId: 'adc-quota-project',
        }
      },
      platformHome: missingPlatformHome,
    })).resolves.toEqual({
      kind: 'adc',
      credential: 'adc-token',
      projectId: 'adc-project',
      quotaProjectId: 'adc-quota-project',
      source: 'GOOGLE_APPLICATION_CREDENTIALS',
    })
    expect(selectedPath).toBe(existingFilePath)
  })

  test('returns a diagnostic plan when the captured environment has no auth source', async () => {
    await expect(selectAndMaterializeGeminiCredential(environment(), {
      platformHome: missingPlatformHome,
      platform: 'linux',
    })).resolves.toEqual({
      kind: 'none',
      mode: 'auto',
      expected: 'any',
      configuredPath:
        '/agenc-test/missing-platform-home/.config/gcloud/application_default_credentials.json',
    })
  })

  test('access-token mode does not silently fall back to ADC', async () => {
    await expect(selectAndMaterializeGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'access-token',
      GOOGLE_APPLICATION_CREDENTIALS: existingFilePath,
    }), {
      createGoogleAuthClient: async () => {
        throw new Error('must not materialize ADC')
      },
      platformHome: missingPlatformHome,
    })).resolves.toEqual({
      kind: 'none',
      mode: 'access-token',
      expected: 'access-token',
    })
  })

  test('adc mode ignores a captured access token', async () => {
    await expect(selectAndMaterializeGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'adc',
      GEMINI_ACCESS_TOKEN: 'token-123',
      GOOGLE_APPLICATION_CREDENTIALS: existingFilePath,
    }), {
      createGoogleAuthClient: async () => ({
        async getAccessToken() {
          return { token: 'adc-token' }
        },
        projectId: 'adc-project',
      }),
      platformHome: missingPlatformHome,
    })).resolves.toEqual({
      kind: 'adc',
      credential: 'adc-token',
      projectId: 'adc-project',
      source: 'GOOGLE_APPLICATION_CREDENTIALS',
    })
  })

  test('does not hide invalid auth modes behind usable credentials', async () => {
    await expect(selectAndMaterializeGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'system',
      GEMINI_API_KEY: 'gem-key',
    }))).rejects.toThrow(
      'Invalid GEMINI_AUTH_MODE "system"; expected api-key, access-token, or adc',
    )
  })

  test('surfaces a selected ADC file failure instead of treating it as no auth', async () => {
    const rootCause = new Error('bad credential document')
    const promise = selectAndMaterializeGeminiCredential(environment({
      GEMINI_AUTH_MODE: 'adc',
      GOOGLE_APPLICATION_CREDENTIALS: existingFilePath,
    }), {
      createGoogleAuthClient: async () => {
        throw rootCause
      },
      platformHome: missingPlatformHome,
    })

    await expect(promise).rejects.toThrow(
      `Gemini ADC credential resolution failed for ${existingFilePath}: bad credential document`,
    )
    await promise.catch(error => {
      expect(error.cause).toBe(rootCause)
    })
  })
})

describe('Gemini credential plan materialization', () => {
  test('rejects unknown fields at the serialized plan boundary', () => {
    expect(() => parseGeminiCredentialPlan({
      kind: 'api-key',
      credential: 'gemini-key',
      source: 'factory',
      accessToken: 'parallel-token',
    })).toThrow('Gemini credential plan contains unsupported fields')
  })

  test('rejects the literal undefined at the serialized plan boundary', () => {
    expect(() => parseGeminiCredentialPlan({
      kind: 'api-key',
      credential: 'undefined',
      source: 'factory',
    })).toThrow('Gemini credential plan requires a non-empty credential')
  })

  test('requests a token on every materialization instead of caching a bearer', async () => {
    const plan: GeminiCredentialPlan = {
      kind: 'adc',
      credentialPath: existingFilePath,
      source: 'GOOGLE_APPLICATION_CREDENTIALS',
    }
    let tokenRequests = 0
    const options = {
      createGoogleAuthClient: async () => ({
        async getAccessToken() {
          tokenRequests += 1
          return { token: `adc-token-${tokenRequests}` }
        },
      }),
    }

    await expect(materializeGeminiCredentialPlan(plan, options)).resolves
      .toMatchObject({ credential: 'adc-token-1' })
    await expect(materializeGeminiCredentialPlan(plan, options)).resolves
      .toMatchObject({ credential: 'adc-token-2' })
    expect(tokenRequests).toBe(2)
  })

  test('rejects URL-bearing external-account credential documents', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenc-gemini-adc-'))
    const credentialPath = join(directory, 'external-account.json')
    writeFileSync(credentialPath, JSON.stringify({
      type: 'external_account',
      audience: 'malicious-audience',
      token_url: 'https://attacker.invalid/token',
      credential_source: {
        executable: { command: '/attacker-controlled-helper' },
      },
    }))

    try {
      await expect(selectAndMaterializeGeminiCredential(environment({
        GEMINI_AUTH_MODE: 'adc',
        GOOGLE_APPLICATION_CREDENTIALS: credentialPath,
      }))).rejects.toThrow(
        'Unsupported Gemini ADC credential type "external_account"; expected authorized_user or service_account',
      )
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
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

  test('an explicit missing ADC path does not fall through to a well-known file', () => {
    expect(resolveGeminiCredentialPlan(environment({
      GEMINI_AUTH_MODE: 'adc',
      GOOGLE_APPLICATION_CREDENTIALS: '/captured/missing.json',
    }), {
      fileExists: path => path ===
        '/captured/home/.config/gcloud/application_default_credentials.json',
      platformHome: '/captured/home',
      platform: 'linux',
    })).toEqual({
      kind: 'none',
      mode: 'adc',
      expected: 'adc',
      configuredPath: '/captured/missing.json',
    })
  })

  test('uses only the platform-appropriate well-known ADC path', () => {
    let windowsPath: string | undefined
    expect(resolveGeminiCredentialPlan(environment({
      GEMINI_AUTH_MODE: 'adc',
      APPDATA: 'C:\\Captured\\AppData',
    }), {
      fileExists: path => {
        windowsPath = path
        return true
      },
      platformHome: '/ignored/home',
      platform: 'win32',
    })).toMatchObject({ kind: 'adc', source: 'well-known-adc' })
    expect(windowsPath).toBe(
      'C:\\Captured\\AppData\\gcloud\\application_default_credentials.json',
    )

    let linuxPath: string | undefined
    expect(resolveGeminiCredentialPlan(environment({
      GEMINI_AUTH_MODE: 'adc',
      APPDATA: '/ignored/appdata',
    }), {
      fileExists: path => {
        linuxPath = path
        return true
      },
      platformHome: '/captured/home',
      platform: 'linux',
    })).toMatchObject({ kind: 'adc', source: 'well-known-adc' })
    expect(linuxPath).toBe(
      '/captured/home/.config/gcloud/application_default_credentials.json',
    )
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
