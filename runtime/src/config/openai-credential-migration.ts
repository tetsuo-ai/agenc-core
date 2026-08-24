import { parseChatgptAccountId } from '../services/api/openAiCodeOAuthShared.js'
import type { SecureStorageData } from '../utils/secureStorage/index.js'

export interface RetiredOpenAiCredential {
  readonly apiKey?: string
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly idToken?: string
  readonly accountId?: string
  readonly profileId?: string
  readonly lastRefreshAt?: number
  readonly lastRefreshFailureAt?: number
}

export type CanonicalOpenAiCredential = NonNullable<
  SecureStorageData['openAiOauth']
>

const RETIRED_FIELDS = new Set([
  'apiKey',
  'accessToken',
  'refreshToken',
  'idToken',
  'accountId',
  'profileId',
  'lastRefreshAt',
  'lastRefreshFailureAt',
])

export class OpenAiCredentialMigrationError extends Error {
  readonly name = 'OpenAiCredentialMigrationError'

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Convert the retired native `agenc` OAuth record into the sole OpenAI record. */
export function migrateRetiredOpenAiCredential(
  value: unknown,
  current: Readonly<CanonicalOpenAiCredential> | undefined,
): CanonicalOpenAiCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenAiCredentialMigrationError(
      'agenc',
      'Retired native OpenAI credentials are not an object.',
    )
  }
  const record = value as Record<string, unknown>
  const unknownFields = Object.keys(record).filter(
    field => !RETIRED_FIELDS.has(field),
  )
  if (unknownFields.length > 0) {
    throw new OpenAiCredentialMigrationError(
      'agenc',
      'Retired native OpenAI credentials contain unsupported fields.',
    )
  }

  const apiKey = nonEmptyString(record.apiKey)
  const accessToken = nonEmptyString(record.accessToken)
  const refreshToken = nonEmptyString(record.refreshToken)
  const idToken = nonEmptyString(record.idToken)
  const explicitAccountId = nonEmptyString(record.accountId)
  const accountId =
    explicitAccountId ??
    parseChatgptAccountId(idToken) ??
    parseChatgptAccountId(accessToken)
  const lastRefreshAt = timestamp(record.lastRefreshAt)
  const lastRefreshFailureAt = timestamp(record.lastRefreshFailureAt)
  if (
    (record.apiKey !== undefined && apiKey === undefined) ||
    (record.accessToken !== undefined && accessToken === undefined) ||
    (record.refreshToken !== undefined && refreshToken === undefined) ||
    (record.idToken !== undefined && idToken === undefined) ||
    (record.accountId !== undefined && explicitAccountId === undefined) ||
    (record.lastRefreshAt !== undefined && lastRefreshAt === undefined) ||
    (record.lastRefreshFailureAt !== undefined &&
      lastRefreshFailureAt === undefined)
  ) {
    throw new OpenAiCredentialMigrationError(
      'agenc',
      'Retired native OpenAI credentials are malformed.',
    )
  }
  if (apiKey === undefined && (accessToken === undefined || accountId === undefined)) {
    throw new OpenAiCredentialMigrationError(
      'agenc',
      'Retired native OpenAI credentials contain no usable platform or ChatGPT credential.',
    )
  }

  const imported = {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(idToken === undefined ? {} : { idToken }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(lastRefreshAt === undefined ? {} : { lastRefreshAt }),
    ...(lastRefreshFailureAt === undefined
      ? {}
      : { lastRefreshFailureAt }),
  }
  const existing = current ?? {}
  for (const [field, importedValue] of Object.entries(imported)) {
    const existingValue = existing[field as keyof typeof existing]
    if (existingValue !== undefined && !sameValue(existingValue, importedValue)) {
      throw new OpenAiCredentialMigrationError(
        `openAiOauth.${field}`,
        `Retired native OpenAI credentials conflict with openAiOauth.${field}.`,
      )
    }
  }

  const merged = { ...existing, ...imported }
  const authMode = merged.apiKey === undefined ? 'chatgpt' : 'apiKey'
  if (existing.authMode !== undefined && existing.authMode !== authMode) {
    throw new OpenAiCredentialMigrationError(
      'openAiOauth.authMode',
      'Retired native OpenAI credentials conflict with openAiOauth.authMode.',
    )
  }
  return { ...merged, authMode }
}
