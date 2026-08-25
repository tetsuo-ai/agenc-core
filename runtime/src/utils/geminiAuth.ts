import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { EnvSnapshot } from '../config/env.js'
import { memoizeWithTTLAsync } from './memoize.js'

const GEMINI_ADC_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const GEMINI_ADC_CACHE_TTL_MS = 5 * 60 * 1000

export type GeminiAuthMode = 'api-key' | 'access-token' | 'adc'

export type GeminiCredentialSource =
  | 'factory'
  | 'GEMINI_API_KEY'
  | 'GOOGLE_API_KEY'
  | 'GEMINI_ACCESS_TOKEN'
  | 'GOOGLE_APPLICATION_CREDENTIALS'
  | 'well-known-adc'

export type GeminiCredentialPlan =
  | {
      kind: 'api-key'
      credential: string
      source: Extract<
        GeminiCredentialSource,
        'factory' | 'GEMINI_API_KEY' | 'GOOGLE_API_KEY'
      >
    }
  | {
      kind: 'access-token'
      credential: string
      projectId?: string
      source: 'GEMINI_ACCESS_TOKEN'
    }
  | {
      kind: 'adc'
      credentialPath: string
      projectId?: string
      source: Extract<
        GeminiCredentialSource,
        'GOOGLE_APPLICATION_CREDENTIALS' | 'well-known-adc'
      >
    }
  | {
      kind: 'none'
    }

type GoogleAccessTokenResult =
  | string
  | null
  | undefined
  | {
      token?: string | null
    }

type GoogleAuthClientLike = {
  getAccessToken(): Promise<GoogleAccessTokenResult> | GoogleAccessTokenResult
  projectId?: string | null
}

type GoogleAuthLike = {
  getClient(): Promise<GoogleAuthClientLike>
}

type GeminiAdcInput = Extract<GeminiCredentialPlan, { kind: 'adc' }>

export type ResolveGeminiCredentialOptions = {
  /** An explicit factory credential; it outranks captured environment input. */
  apiKey?: string
  createGoogleAuth?: (input: GeminiAdcInput) => Promise<GoogleAuthLike>
  fileExists?: (path: string) => boolean
  /** Operating-system account home used only for the standard ADC path. */
  platformHome?: string
  platform?: NodeJS.Platform
}

export type GeminiResolvedCredential =
  | Extract<GeminiCredentialPlan, { kind: 'api-key' | 'access-token' }>
  | {
      kind: 'adc'
      credential: string
      projectId?: string
      source: GeminiAdcInput['source']
    }
  | {
      kind: 'none'
    }

function sanitizeCredential(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed !== 'undefined' ? trimmed : undefined
}

export function getGeminiProjectIdHint(env: EnvSnapshot): string | undefined {
  return (
    sanitizeCredential(env.GEMINI_PROJECT_ID) ??
    sanitizeCredential(env.GOOGLE_CLOUD_PROJECT)
  )
}

export function getGeminiAuthMode(env: EnvSnapshot): GeminiAuthMode | undefined {
  const normalized = sanitizeCredential(env.GEMINI_AUTH_MODE)?.toLowerCase()
  if (normalized === undefined) return undefined
  if (
    normalized === 'api-key' ||
    normalized === 'access-token' ||
    normalized === 'adc'
  ) {
    return normalized
  }
  throw new Error(
    `Invalid GEMINI_AUTH_MODE ${JSON.stringify(env.GEMINI_AUTH_MODE)}; expected api-key, access-token, or adc`,
  )
}

/**
 * Return the one file-backed ADC search path allowed by the captured runtime
 * context. An explicit GOOGLE_APPLICATION_CREDENTIALS path is authoritative;
 * it never falls through to a well-known file when missing.
 */
export function getGeminiAdcCredentialPaths(
  env: EnvSnapshot,
  platformHome: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const explicit = sanitizeCredential(env.GOOGLE_APPLICATION_CREDENTIALS)
  if (explicit !== undefined) return [explicit]

  if (platform === 'win32') {
    const appData = sanitizeCredential(env.APPDATA)
    return appData === undefined
      ? []
      : [join(appData, 'gcloud', 'application_default_credentials.json')]
  }

  return [
    join(
      platformHome,
      '.config',
      'gcloud',
      'application_default_credentials.json',
    ),
  ]
}

export function mayHaveGeminiAdcCredentials(
  env: EnvSnapshot,
  platformHome: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return getGeminiAdcCredentialPaths(env, platformHome, platform).some(path =>
    existsSync(path),
  )
}

function resolveGeminiAdcPlan(
  env: EnvSnapshot,
  options: ResolveGeminiCredentialOptions,
): GeminiAdcInput | { kind: 'none' } {
  const platformHome =
    options.platformHome ?? sanitizeCredential(env.HOME) ?? homedir()
  const credentialPath = getGeminiAdcCredentialPaths(
    env,
    platformHome,
    options.platform ?? process.platform,
  ).find(options.fileExists ?? existsSync)
  if (credentialPath === undefined) return { kind: 'none' }

  const projectId = getGeminiProjectIdHint(env)
  return {
    kind: 'adc',
    credentialPath,
    source: sanitizeCredential(env.GOOGLE_APPLICATION_CREDENTIALS) !== undefined
      ? 'GOOGLE_APPLICATION_CREDENTIALS'
      : 'well-known-adc',
    ...(projectId !== undefined ? { projectId } : {}),
  }
}

/**
 * Select exactly one Gemini credential source without performing I/O beyond
 * checking the selected ADC file. All Gemini transports consume this plan.
 */
export function resolveGeminiCredentialPlan(
  env: EnvSnapshot,
  options: ResolveGeminiCredentialOptions = {},
): GeminiCredentialPlan {
  // Parse first so an invalid mode is never hidden by another credential.
  const authMode = getGeminiAuthMode(env)
  const explicitApiKey = sanitizeCredential(options.apiKey)
  if (explicitApiKey !== undefined) {
    return {
      kind: 'api-key',
      credential: explicitApiKey,
      source: 'factory',
    }
  }

  const geminiApiKey = sanitizeCredential(env.GEMINI_API_KEY)
  const googleApiKey = sanitizeCredential(env.GOOGLE_API_KEY)
  const accessToken = sanitizeCredential(env.GEMINI_ACCESS_TOKEN)
  const projectId = getGeminiProjectIdHint(env)

  if (authMode === undefined || authMode === 'api-key') {
    if (geminiApiKey !== undefined) {
      return {
        kind: 'api-key',
        credential: geminiApiKey,
        source: 'GEMINI_API_KEY',
      }
    }
    if (googleApiKey !== undefined) {
      return {
        kind: 'api-key',
        credential: googleApiKey,
        source: 'GOOGLE_API_KEY',
      }
    }
    if (authMode === 'api-key') return { kind: 'none' }
  }

  if (authMode === undefined || authMode === 'access-token') {
    if (accessToken !== undefined) {
      return {
        kind: 'access-token',
        credential: accessToken,
        source: 'GEMINI_ACCESS_TOKEN',
        ...(projectId !== undefined ? { projectId } : {}),
      }
    }
    if (authMode === 'access-token') return { kind: 'none' }
  }

  return resolveGeminiAdcPlan(env, options)
}

function normalizeAccessToken(
  value: GoogleAccessTokenResult,
): string | undefined {
  if (typeof value === 'string') {
    return sanitizeCredential(value)
  }
  return sanitizeCredential(value?.token)
}

async function createDefaultGoogleAuth(
  input: GeminiAdcInput,
): Promise<GoogleAuthLike> {
  const { GoogleAuth } = await import('google-auth-library')
  // The selected path is operator-owned credential input. Supplying it
  // explicitly prevents GoogleAuth from consulting ambient variables, gcloud,
  // or the metadata server after AgenC has captured the session environment.
  return new GoogleAuth({
    keyFilename: input.credentialPath,
    scopes: [GEMINI_ADC_SCOPE],
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
  }) as GoogleAuthLike
}

async function resolveGeminiAdcCredentialUncached(
  input: GeminiAdcInput,
  createGoogleAuth: NonNullable<
    ResolveGeminiCredentialOptions['createGoogleAuth']
  >,
): Promise<Extract<GeminiResolvedCredential, { kind: 'adc' }>> {
  try {
    const auth = await createGoogleAuth(input)
    const client = await auth.getClient()
    const accessToken = normalizeAccessToken(await client.getAccessToken())
    if (accessToken === undefined) {
      throw new Error('Google auth returned an empty access token')
    }

    const projectId = input.projectId ?? sanitizeCredential(client.projectId)
    return {
      kind: 'adc',
      credential: accessToken,
      source: input.source,
      ...(projectId !== undefined ? { projectId } : {}),
    }
  } catch (error) {
    throw new Error(
      `Gemini ADC credential resolution failed for ${input.credentialPath}`,
      { cause: error },
    )
  }
}

const resolveDefaultGeminiAdcCredential = memoizeWithTTLAsync(
  async (
    credentialPath: string,
    projectId: string | undefined,
    source: GeminiAdcInput['source'],
  ) =>
    resolveGeminiAdcCredentialUncached(
      {
        kind: 'adc',
        credentialPath,
        source,
        ...(projectId !== undefined ? { projectId } : {}),
      },
      createDefaultGoogleAuth,
    ),
  GEMINI_ADC_CACHE_TTL_MS,
)

export async function resolveGeminiCredential(
  env: EnvSnapshot,
  options: ResolveGeminiCredentialOptions = {},
): Promise<GeminiResolvedCredential> {
  const plan = resolveGeminiCredentialPlan(env, options)
  if (plan.kind !== 'adc') return plan

  if (options.createGoogleAuth !== undefined) {
    return resolveGeminiAdcCredentialUncached(plan, options.createGoogleAuth)
  }

  return resolveDefaultGeminiAdcCredential(
    plan.credentialPath,
    plan.projectId,
    plan.source,
  )
}
