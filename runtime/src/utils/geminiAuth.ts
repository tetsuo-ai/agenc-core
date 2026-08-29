import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { posix, win32 } from 'node:path'

import type { EnvSnapshot } from '../config/env.js'
import { readBoundedRegularFile } from './bounded-regular-file.js'
import { memoizeWithTTLAsync } from './memoize.js'

const GEMINI_ADC_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const GEMINI_ADC_CACHE_TTL_MS = 5 * 60 * 1000
const GEMINI_ADC_FILE_MAX_BYTES = 1024 * 1024

export type GeminiAuthMode = 'api-key' | 'access-token' | 'adc'

export type GeminiCredentialSource =
  | 'factory'
  | 'saved-byok'
  | 'GEMINI_API_KEY'
  | 'GOOGLE_API_KEY'
  | 'GEMINI_ACCESS_TOKEN'
  | 'GOOGLE_APPLICATION_CREDENTIALS'
  | 'well-known-adc'

export type GeminiMissingCredentialPlan = {
  kind: 'none'
  mode: GeminiAuthMode | 'auto'
  expected: GeminiAuthMode | 'any'
  configuredPath?: string
}

export type GeminiCredentialPlan =
  | {
      kind: 'api-key'
      credential: string
      source: Extract<
        GeminiCredentialSource,
        'factory' | 'saved-byok' | 'GEMINI_API_KEY' | 'GOOGLE_API_KEY'
      >
    }
  | {
      kind: 'access-token'
      credential: string
      projectId?: string
      quotaProjectId?: string
      source: 'GEMINI_ACCESS_TOKEN'
    }
  | {
      kind: 'adc'
      credentialPath: string
      projectId?: string
      quotaProjectId?: string
      source: Extract<
        GeminiCredentialSource,
        'GOOGLE_APPLICATION_CREDENTIALS' | 'well-known-adc'
      >
    }
  | GeminiMissingCredentialPlan

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
  quotaProjectId?: string | null
}

type GeminiAdcInput = Extract<GeminiCredentialPlan, { kind: 'adc' }>

export type ResolveGeminiCredentialOptions = {
  /** An explicit factory credential; it outranks API-key environment input. */
  apiKey?: string
  /** A native secure storage BYOK candidate, subject to API-key mode precedence. */
  savedApiKey?: string
  createGoogleAuthClient?: (
    input: GeminiAdcInput,
  ) => Promise<GoogleAuthClientLike>
  fileExists?: (path: string) => boolean
  /** Trusted operating-system account home for the standard ADC path. */
  platformHome?: string
  platform?: NodeJS.Platform
}

export type GeminiResolvedCredential =
  | Extract<GeminiCredentialPlan, { kind: 'api-key' | 'access-token' }>
  | {
      kind: 'adc'
      credential: string
      projectId?: string
      quotaProjectId?: string
      source: GeminiAdcInput['source']
    }
  | GeminiMissingCredentialPlan

/** Build the sole native-transport header projection of a resolved plan. */
export function geminiCredentialHeaders(
  credential: GeminiResolvedCredential,
): Record<string, string> | undefined {
  if (credential.kind === 'none') return undefined
  if (credential.kind === 'api-key') {
    return { 'x-goog-api-key': credential.credential }
  }
  return {
    authorization: `Bearer ${credential.credential}`,
    ...(credential.quotaProjectId !== undefined
      ? { 'x-goog-user-project': credential.quotaProjectId }
      : {}),
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertOnlyCredentialPlanKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error('Gemini credential plan contains unsupported fields')
  }
}

function optionalPlanString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const candidate = value[key]
  if (candidate === undefined) return undefined
  if (
    typeof candidate !== 'string' ||
    candidate.trim().length === 0 ||
    candidate.trim() === 'undefined'
  ) {
    throw new Error(`Gemini credential plan requires a non-empty ${key}`)
  }
  return candidate.trim()
}

function requiredPlanString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const candidate = optionalPlanString(value, key)
  if (candidate === undefined) {
    throw new Error(`Gemini credential plan requires a non-empty ${key}`)
  }
  return candidate
}

/** Validate and clone a credential plan crossing an untyped runtime boundary. */
export function parseGeminiCredentialPlan(value: unknown): GeminiCredentialPlan {
  if (!isRecord(value)) {
    throw new Error('Gemini runtime options require a credentialPlan')
  }
  switch (value.kind) {
    case 'api-key': {
      assertOnlyCredentialPlanKeys(value, ['kind', 'credential', 'source'])
      const source = value.source
      if (
        source !== 'factory' &&
        source !== 'saved-byok' &&
        source !== 'GEMINI_API_KEY' &&
        source !== 'GOOGLE_API_KEY'
      ) {
        throw new Error('Gemini API-key credential plan has an invalid source')
      }
      return Object.freeze({
        kind: 'api-key',
        credential: requiredPlanString(value, 'credential'),
        source,
      })
    }
    case 'access-token': {
      assertOnlyCredentialPlanKeys(value, [
        'kind',
        'credential',
        'projectId',
        'quotaProjectId',
        'source',
      ])
      if (value.source !== 'GEMINI_ACCESS_TOKEN') {
        throw new Error('Gemini access-token credential plan has an invalid source')
      }
      const projectId = optionalPlanString(value, 'projectId')
      const quotaProjectId = optionalPlanString(value, 'quotaProjectId')
      return Object.freeze({
        kind: 'access-token',
        credential: requiredPlanString(value, 'credential'),
        source: 'GEMINI_ACCESS_TOKEN',
        ...(projectId !== undefined ? { projectId } : {}),
        ...(quotaProjectId !== undefined ? { quotaProjectId } : {}),
      })
    }
    case 'adc': {
      assertOnlyCredentialPlanKeys(value, [
        'kind',
        'credentialPath',
        'projectId',
        'quotaProjectId',
        'source',
      ])
      const source = value.source
      if (
        source !== 'GOOGLE_APPLICATION_CREDENTIALS' &&
        source !== 'well-known-adc'
      ) {
        throw new Error('Gemini ADC credential plan has an invalid source')
      }
      const projectId = optionalPlanString(value, 'projectId')
      const quotaProjectId = optionalPlanString(value, 'quotaProjectId')
      return Object.freeze({
        kind: 'adc',
        credentialPath: requiredPlanString(value, 'credentialPath'),
        source,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(quotaProjectId !== undefined ? { quotaProjectId } : {}),
      })
    }
    case 'none': {
      assertOnlyCredentialPlanKeys(value, [
        'kind',
        'mode',
        'expected',
        'configuredPath',
      ])
      const mode = value.mode
      const expected = value.expected
      const valid =
        (mode === 'auto' && expected === 'any') ||
        (mode === 'api-key' && expected === 'api-key') ||
        (mode === 'access-token' && expected === 'access-token') ||
        (mode === 'adc' && expected === 'adc')
      if (!valid) {
        throw new Error('Gemini missing-credential plan is inconsistent')
      }
      const configuredPath = optionalPlanString(value, 'configuredPath')
      return Object.freeze({
        kind: 'none',
        mode,
        expected,
        ...(configuredPath !== undefined ? { configuredPath } : {}),
      })
    }
    default:
      throw new Error('Gemini credential plan has an invalid kind')
  }
}

function sanitizeCredential(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed !== 'undefined' ? trimmed : undefined
}

function optionalDocumentString(
  document: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = document[name]
  return typeof value === 'string' ? sanitizeCredential(value) : undefined
}

function requiredDocumentString(
  document: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = optionalDocumentString(document, name)
  if (value === undefined) {
    throw new Error(`Gemini ADC credential file is missing ${name}`)
  }
  return value
}

export function getGeminiProjectIdHint(env: EnvSnapshot): string | undefined {
  return (
    sanitizeCredential(env.GEMINI_PROJECT_ID) ??
    sanitizeCredential(env.GOOGLE_CLOUD_PROJECT)
  )
}

export function getGeminiQuotaProjectIdHint(
  env: EnvSnapshot,
): string | undefined {
  return sanitizeCredential(env.GOOGLE_CLOUD_QUOTA_PROJECT)
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

function missingCredentialPlan(
  authMode: GeminiAuthMode | undefined,
  configuredPath?: string,
): GeminiMissingCredentialPlan {
  return {
    kind: 'none',
    mode: authMode ?? 'auto',
    expected: authMode ?? 'any',
    ...(configuredPath !== undefined ? { configuredPath } : {}),
  }
}

/** Resolve the sole file-backed ADC candidate from captured/trusted context. */
function getGeminiAdcCredentialPath(
  env: EnvSnapshot,
  platformHome: string,
  platform: NodeJS.Platform,
): string | undefined {
  const explicit = sanitizeCredential(env.GOOGLE_APPLICATION_CREDENTIALS)
  if (explicit !== undefined) return explicit

  if (platform === 'win32') {
    const appData = sanitizeCredential(env.APPDATA)
    return appData === undefined
      ? undefined
      : win32.join(
          appData,
          'gcloud',
          'application_default_credentials.json',
        )
  }

  return posix.join(
    platformHome,
    '.config',
    'gcloud',
    'application_default_credentials.json',
  )
}

function resolveGeminiAdcPlan(
  env: EnvSnapshot,
  authMode: GeminiAuthMode | undefined,
  options: ResolveGeminiCredentialOptions,
): GeminiAdcInput | GeminiMissingCredentialPlan {
  const credentialPath = getGeminiAdcCredentialPath(
    env,
    options.platformHome ?? userInfo().homedir,
    options.platform ?? process.platform,
  )
  if (
    credentialPath === undefined ||
    !(options.fileExists ?? existsSync)(credentialPath)
  ) {
    return missingCredentialPlan(authMode, credentialPath)
  }

  const projectId = getGeminiProjectIdHint(env)
  const quotaProjectId = getGeminiQuotaProjectIdHint(env)
  return {
    kind: 'adc',
    credentialPath,
    source: sanitizeCredential(env.GOOGLE_APPLICATION_CREDENTIALS) !== undefined
      ? 'GOOGLE_APPLICATION_CREDENTIALS'
      : 'well-known-adc',
    ...(projectId !== undefined ? { projectId } : {}),
    ...(quotaProjectId !== undefined ? { quotaProjectId } : {}),
  }
}

/**
 * Select exactly one Gemini credential source without exchanging a token.
 * Every Gemini transport consumes this immutable plan.
 */
export function resolveGeminiCredentialPlan(
  env: EnvSnapshot,
  options: ResolveGeminiCredentialOptions = {},
): GeminiCredentialPlan {
  // Parse first so an invalid mode is never hidden by another credential.
  const authMode = getGeminiAuthMode(env)
  const explicitApiKey = sanitizeCredential(options.apiKey)
  const geminiApiKey = sanitizeCredential(env.GEMINI_API_KEY)
  const googleApiKey = sanitizeCredential(env.GOOGLE_API_KEY)
  const savedApiKey = sanitizeCredential(options.savedApiKey)
  const accessToken = sanitizeCredential(env.GEMINI_ACCESS_TOKEN)
  const projectId = getGeminiProjectIdHint(env)
  const quotaProjectId = getGeminiQuotaProjectIdHint(env)

  if (authMode === undefined || authMode === 'api-key') {
    if (explicitApiKey !== undefined) {
      return {
        kind: 'api-key',
        credential: explicitApiKey,
        source: 'factory',
      }
    }
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
    if (savedApiKey !== undefined) {
      return {
        kind: 'api-key',
        credential: savedApiKey,
        source: 'saved-byok',
      }
    }
    if (authMode === 'api-key') return missingCredentialPlan(authMode)
  }

  if (authMode === undefined || authMode === 'access-token') {
    if (accessToken !== undefined) {
      return {
        kind: 'access-token',
        credential: accessToken,
        source: 'GEMINI_ACCESS_TOKEN',
        ...(projectId !== undefined ? { projectId } : {}),
        ...(quotaProjectId !== undefined ? { quotaProjectId } : {}),
      }
    }
    if (authMode === 'access-token') return missingCredentialPlan(authMode)
  }

  return resolveGeminiAdcPlan(env, authMode, options)
}

function normalizeAccessToken(
  value: GoogleAccessTokenResult,
): string | undefined {
  if (typeof value === 'string') return sanitizeCredential(value)
  return sanitizeCredential(value?.token)
}

function parseCredentialDocument(
  raw: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('Gemini ADC credential file is not valid JSON', {
      cause: error,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Gemini ADC credential file must contain a JSON object')
  }
  return parsed as Readonly<Record<string, unknown>>
}

async function createDefaultGoogleAuthClient(
  input: GeminiAdcInput,
): Promise<GoogleAuthClientLike> {
  const canonicalPath = await realpath(input.credentialPath)
  const raw = await readBoundedRegularFile(
    canonicalPath,
    GEMINI_ADC_FILE_MAX_BYTES,
  )
  const document = parseCredentialDocument(raw)
  const credentialType = requiredDocumentString(document, 'type')
  const universeDomain = optionalDocumentString(document, 'universe_domain')
  if (universeDomain !== undefined && universeDomain !== 'googleapis.com') {
    throw new Error(
      'Gemini ADC supports only the googleapis.com credential universe',
    )
  }

  const projectId =
    input.projectId ?? optionalDocumentString(document, 'project_id')
  const quotaProjectId =
    input.quotaProjectId ?? optionalDocumentString(document, 'quota_project_id')
  const commonOptions = {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(quotaProjectId !== undefined ? { quotaProjectId } : {}),
  }

  const { JWT, UserRefreshClient } = await import('google-auth-library')
  if (credentialType === 'service_account') {
    const keyId = optionalDocumentString(document, 'private_key_id')
    return new JWT({
      ...commonOptions,
      email: requiredDocumentString(document, 'client_email'),
      key: requiredDocumentString(document, 'private_key'),
      ...(keyId !== undefined ? { keyId } : {}),
      scopes: [GEMINI_ADC_SCOPE],
    })
  }
  if (credentialType === 'authorized_user') {
    return new UserRefreshClient({
      ...commonOptions,
      clientId: requiredDocumentString(document, 'client_id'),
      clientSecret: requiredDocumentString(document, 'client_secret'),
      refreshToken: requiredDocumentString(document, 'refresh_token'),
    })
  }

  throw new Error(
    `Unsupported Gemini ADC credential type ${JSON.stringify(credentialType)}; expected authorized_user or service_account`,
  )
}

const resolveDefaultGeminiAdcClient = memoizeWithTTLAsync(
  async (
    credentialPath: string,
    projectId: string | undefined,
    quotaProjectId: string | undefined,
    source: GeminiAdcInput['source'],
  ) =>
    createDefaultGoogleAuthClient({
      kind: 'adc',
      credentialPath,
      source,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(quotaProjectId !== undefined ? { quotaProjectId } : {}),
    }),
  GEMINI_ADC_CACHE_TTL_MS,
)

/** Exchange the already-selected credential plan without selecting again. */
export async function materializeGeminiCredentialPlan(
  plan: GeminiCredentialPlan,
  options: ResolveGeminiCredentialOptions = {},
): Promise<GeminiResolvedCredential> {
  if (plan.kind !== 'adc') return plan

  try {
    const client = options.createGoogleAuthClient === undefined
      ? await resolveDefaultGeminiAdcClient(
          plan.credentialPath,
          plan.projectId,
          plan.quotaProjectId,
          plan.source,
        )
      : await options.createGoogleAuthClient(plan)
    // Deliberately request the token on every materialization. The auth client
    // owns expiry and refresh; AgenC caches the client, never a raw bearer.
    const accessToken = normalizeAccessToken(await client.getAccessToken())
    if (accessToken === undefined) {
      throw new Error('Google auth returned an empty access token')
    }

    const projectId = plan.projectId ?? sanitizeCredential(client.projectId)
    const quotaProjectId =
      plan.quotaProjectId ?? sanitizeCredential(client.quotaProjectId)
    return {
      kind: 'adc',
      credential: accessToken,
      source: plan.source,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(quotaProjectId !== undefined ? { quotaProjectId } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new Error(
      `Gemini ADC credential resolution failed for ${plan.credentialPath}${detail}`,
      { cause: error },
    )
  }
}
