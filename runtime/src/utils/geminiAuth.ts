import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { EnvSnapshot } from '../config/env.js'
import { memoizeWithTTLAsync } from './memoize.js'

const GEMINI_ADC_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const GEMINI_ADC_CACHE_TTL_MS = 5 * 60 * 1000

export type GeminiAuthMode = 'api-key' | 'access-token' | 'adc'

type GoogleAccessTokenResult =
  | string
  | null
  | undefined
  | {
      token?: string | null
    }

type GoogleAuthClientLike = {
  getAccessToken(): Promise<GoogleAccessTokenResult> | GoogleAccessTokenResult
}

type GoogleAuthLike = {
  getClient(): Promise<GoogleAuthClientLike>
  getProjectId?(): Promise<string>
}

export type GeminiResolvedCredential =
  | {
      kind: 'api-key'
      credential: string
    }
  | {
      kind: 'access-token' | 'adc'
      credential: string
      projectId?: string
    }
  | {
      kind: 'none'
    }

type ResolveGeminiCredentialDeps = {
  createGoogleAuth?: () => Promise<GoogleAuthLike>
  /** Operating-system account home used only for the standard ADC path. */
  platformHome?: string
}

function sanitizeCredential(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function getGeminiProjectIdHint(env: EnvSnapshot): string | undefined {
  return (
    sanitizeCredential(env.GEMINI_PROJECT_ID) ??
    sanitizeCredential(env.GOOGLE_CLOUD_PROJECT)
  )
}

export function getGeminiAuthMode(env: EnvSnapshot): GeminiAuthMode | undefined {
  const normalized = sanitizeCredential(env.GEMINI_AUTH_MODE)?.toLowerCase()
  if (
    normalized === 'api-key' ||
    normalized === 'access-token' ||
    normalized === 'adc'
  ) {
    return normalized
  }
  return undefined
}

export function getGeminiAdcCredentialPaths(
  env: EnvSnapshot,
  platformHome: string,
): string[] {
  const explicit = sanitizeCredential(env.GOOGLE_APPLICATION_CREDENTIALS)
  const paths = new Set<string>()

  if (explicit) {
    paths.add(explicit)
  }

  paths.add(
    join(
      platformHome,
      '.config',
      'gcloud',
      'application_default_credentials.json',
    ),
  )

  const appData = sanitizeCredential(env.APPDATA)
  if (appData) {
    paths.add(join(appData, 'gcloud', 'application_default_credentials.json'))
  }

  return [...paths]
}

export function mayHaveGeminiAdcCredentials(
  env: EnvSnapshot,
  platformHome: string,
): boolean {
  return getGeminiAdcCredentialPaths(env, platformHome).some(path =>
    existsSync(path),
  )
}

function normalizeAccessToken(
  value: GoogleAccessTokenResult,
): string | undefined {
  if (typeof value === 'string') {
    return sanitizeCredential(value)
  }
  return sanitizeCredential(value?.token)
}

async function createDefaultGoogleAuth(): Promise<GoogleAuthLike> {
  const { GoogleAuth } = await import('google-auth-library')
  return new GoogleAuth({
    scopes: [GEMINI_ADC_SCOPE],
  }) as GoogleAuthLike
}

async function resolveGeminiAdcCredentialUncached(
  env: EnvSnapshot,
  deps: ResolveGeminiCredentialDeps,
): Promise<Exclude<GeminiResolvedCredential, { kind: 'none' | 'api-key' | 'access-token' }> | { kind: 'none' }> {
  const platformHome = deps.platformHome ?? homedir()
  if (!mayHaveGeminiAdcCredentials(env, platformHome)) {
    return { kind: 'none' }
  }

  try {
    const auth = await (deps.createGoogleAuth ?? createDefaultGoogleAuth)()
    const client = await auth.getClient()
    const accessToken = normalizeAccessToken(await client.getAccessToken())
    if (!accessToken) {
      return { kind: 'none' }
    }

    const hintedProjectId = getGeminiProjectIdHint(env)
    const resolvedProjectId =
      hintedProjectId ??
      (typeof auth.getProjectId === 'function'
        ? sanitizeCredential(await auth.getProjectId().catch(() => undefined))
        : undefined)

    return {
      kind: 'adc',
      credential: accessToken,
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
    }
  } catch {
    return { kind: 'none' }
  }
}

const resolveDefaultGeminiAdcCredential = memoizeWithTTLAsync(
  async (
    googleApplicationCredentials: string | undefined,
    appData: string | undefined,
    home: string,
    projectIdHint: string | undefined,
  ) =>
    resolveGeminiAdcCredentialUncached(
      {
        GOOGLE_APPLICATION_CREDENTIALS: googleApplicationCredentials,
        APPDATA: appData,
        GEMINI_PROJECT_ID: projectIdHint,
      },
      { platformHome: home },
    ),
  GEMINI_ADC_CACHE_TTL_MS,
)

export async function resolveGeminiCredential(
  env: EnvSnapshot,
  deps: ResolveGeminiCredentialDeps = {},
): Promise<GeminiResolvedCredential> {
  const authMode = getGeminiAuthMode(env)
  const apiKey =
    authMode === 'access-token' || authMode === 'adc'
      ? undefined
      : sanitizeCredential(env.GEMINI_API_KEY) ??
        sanitizeCredential(env.GOOGLE_API_KEY)
  if (apiKey && (authMode === undefined || authMode === 'api-key')) {
    return {
      kind: 'api-key',
      credential: apiKey,
    }
  }

  const accessToken =
    authMode === 'api-key' || authMode === 'adc'
      ? undefined
      : sanitizeCredential(env.GEMINI_ACCESS_TOKEN)
  if (accessToken && (authMode === undefined || authMode === 'access-token')) {
    const projectId = getGeminiProjectIdHint(env)
    return {
      kind: 'access-token',
      credential: accessToken,
      ...(projectId ? { projectId } : {}),
    }
  }

  if (authMode === 'api-key' || authMode === 'access-token') {
    return { kind: 'none' }
  }

  if (deps.createGoogleAuth) {
    return resolveGeminiAdcCredentialUncached(env, deps)
  }

  return resolveDefaultGeminiAdcCredential(
    sanitizeCredential(env.GOOGLE_APPLICATION_CREDENTIALS),
    sanitizeCredential(env.APPDATA),
    deps.platformHome ?? homedir(),
    getGeminiProjectIdHint(env),
  )
}
