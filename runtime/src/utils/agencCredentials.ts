// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
import { isBareMode } from './envUtils.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  asTrimmedString,
  CODEX_REFRESH_URL as AGENC_REFRESH_URL,
  exchangeCodexIdTokenForApiKey as exchangeAgencIdTokenForApiKey,
  getCodexOAuthClientId as getAgencOAuthClientId,
  parseChatgptAccountId,
  decodeJwtPayload,
} from '../services/api/openAiCodeOAuthShared.js'

export const AGENC_STORAGE_KEY = 'agenc' as const
const AGENC_TOKEN_REFRESH_SKEW_MS = 60_000
const AGENC_TOKEN_REFRESH_RETRY_COOLDOWN_MS = 60_000

export type AgencCredentialBlob = {
  apiKey?: string
  accessToken: string
  refreshToken?: string
  idToken?: string
  accountId?: string
  profileId?: string
  lastRefreshAt?: number
  lastRefreshFailureAt?: number
}

type AgencTokenRefreshResponse = {
  access_token?: string
  refresh_token?: string
  id_token?: string
}

let inFlightAgencRefresh:
  | Promise<{
      refreshed: boolean
      credentials?: AgencCredentialBlob
    }>
  | null = null
let inMemoryLastRefreshFailureAt: number | null = null

function getAgencSecureStorage() {
  return getSecureStorage({ allowPlainTextFallback: false })
}

function parseJwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  if (typeof exp === 'number' && Number.isFinite(exp)) {
    return exp * 1000
  }
  return undefined
}

function normalizeAgencCredentialBlob(
  value: unknown,
): AgencCredentialBlob | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const apiKey = asTrimmedString(record.apiKey)
  const accessToken = asTrimmedString(record.accessToken)
  if (!accessToken) return undefined

  const refreshToken = asTrimmedString(record.refreshToken)
  const idToken = asTrimmedString(record.idToken)
  const accountId =
    asTrimmedString(record.accountId) ??
    parseChatgptAccountId(idToken) ??
    parseChatgptAccountId(accessToken)
  const profileId = asTrimmedString(record.profileId)

  const lastRefreshAt =
    typeof record.lastRefreshAt === 'number' &&
    Number.isFinite(record.lastRefreshAt)
      ? record.lastRefreshAt
      : undefined
  const lastRefreshFailureAt =
    typeof record.lastRefreshFailureAt === 'number' &&
    Number.isFinite(record.lastRefreshFailureAt)
      ? record.lastRefreshFailureAt
      : undefined

  return {
    apiKey,
    accessToken,
    refreshToken,
    idToken,
    accountId,
    profileId,
    lastRefreshAt,
    lastRefreshFailureAt,
  }
}

function shouldRefreshAgencToken(blob: AgencCredentialBlob): boolean {
  const expiresAt =
    parseJwtExpiryMs(blob.accessToken) ?? parseJwtExpiryMs(blob.idToken)
  if (expiresAt === undefined) {
    return false
  }
  return expiresAt <= Date.now() + AGENC_TOKEN_REFRESH_SKEW_MS
}

function isWithinRefreshFailureCooldown(
  blob: AgencCredentialBlob,
  now = Date.now(),
): boolean {
  const lastRefreshFailureAt = Math.max(
    blob.lastRefreshFailureAt ?? 0,
    inMemoryLastRefreshFailureAt ?? 0,
  )

  if (!lastRefreshFailureAt) {
    return false
  }

  return (
    now - lastRefreshFailureAt < AGENC_TOKEN_REFRESH_RETRY_COOLDOWN_MS
  )
}

function getRefreshErrorMessage(
  status: number,
  bodyText: string,
): string {
  if (!bodyText.trim()) {
    return `Agenc token refresh failed with status ${status}.`
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const nestedError =
      parsed.error && typeof parsed.error === 'object'
        ? (parsed.error as Record<string, unknown>)
        : undefined
    const code = asTrimmedString(nestedError?.code ?? parsed.code)
    const message =
      asTrimmedString(nestedError?.message ?? parsed.error_description) ??
      bodyText.trim()
    return code
      ? `Agenc token refresh failed (${code}): ${message}`
      : `Agenc token refresh failed with status ${status}: ${message}`
  } catch {
    return `Agenc token refresh failed with status ${status}: ${bodyText.trim()}`
  }
}

export function readAgencCredentials(): AgencCredentialBlob | undefined {
  if (isBareMode()) return undefined

  try {
    const data = getAgencSecureStorage().read()
    return normalizeAgencCredentialBlob(data?.agenc)
  } catch {
    return undefined
  }
}

export async function readAgencCredentialsAsync(): Promise<
  AgencCredentialBlob | undefined
> {
  if (isBareMode()) return undefined

  try {
    const data = await getAgencSecureStorage().readAsync()
    return normalizeAgencCredentialBlob(data?.agenc)
  } catch {
    return undefined
  }
}

export function isAgencRefreshFailureCoolingDown(
  blob: Pick<AgencCredentialBlob, 'lastRefreshFailureAt'>,
  now = Date.now(),
): boolean {
  return isWithinRefreshFailureCooldown(
    blob as AgencCredentialBlob,
    now,
  )
}

export function saveAgencCredentials(
  credentials: AgencCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const normalized = normalizeAgencCredentialBlob(credentials)
  if (!normalized) {
    return { success: false, warning: 'Agenc credentials are incomplete.' }
  }

  const secureStorage = getAgencSecureStorage()
  const previous = secureStorage.read() || {}
  const previousAgenc = normalizeAgencCredentialBlob(previous[AGENC_STORAGE_KEY])
  const next = {
    ...(previous as Record<string, unknown>),
    [AGENC_STORAGE_KEY]: {
      ...normalized,
      profileId: normalized.profileId ?? previousAgenc?.profileId,
      lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
    },
  }
  const result = secureStorage.update(next as typeof previous)
  if (result.success) {
    const storedAgenc = normalizeAgencCredentialBlob(next[AGENC_STORAGE_KEY])
    inMemoryLastRefreshFailureAt = storedAgenc?.lastRefreshFailureAt ?? null
  }
  return result
}

export function attachAgencProfileIdToStoredCredentials(profileId: string): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const current = readAgencCredentials()
  if (!current) {
    return {
      success: false,
      warning: 'Agenc credentials are not stored securely yet.',
    }
  }

  return saveAgencCredentials({
    ...current,
    profileId,
  })
}

function persistAgencRefreshFailure(
  credentials: AgencCredentialBlob,
  occurredAt: number,
): void {
  const result = saveAgencCredentials({
    ...credentials,
    lastRefreshFailureAt: occurredAt,
  })
  if (!result.success) {
    inMemoryLastRefreshFailureAt = occurredAt
  }
}

export function clearAgencCredentials(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: true }
  }

  const secureStorage = getAgencSecureStorage()
  const previous = secureStorage.read() || {}
  const next = { ...(previous as Record<string, unknown>) }
  delete next[AGENC_STORAGE_KEY]
  const result = secureStorage.update(next as typeof previous)
  if (result.success) {
    inMemoryLastRefreshFailureAt = null
  }
  return result
}

export async function refreshAgencAccessTokenIfNeeded(options?: {
  force?: boolean
}): Promise<{
  refreshed: boolean
  credentials?: AgencCredentialBlob
}> {
  if (isBareMode()) {
    return { refreshed: false }
  }

  if (process.env.AGENC_API_KEY?.trim()) {
    return { refreshed: false }
  }

  const current = await readAgencCredentialsAsync()
  if (!current) {
    return { refreshed: false }
  }

  if (!current.refreshToken) {
    return { refreshed: false, credentials: current }
  }

  if (!options?.force && !shouldRefreshAgencToken(current)) {
    return { refreshed: false, credentials: current }
  }

  if (!options?.force && isWithinRefreshFailureCooldown(current)) {
    return { refreshed: false, credentials: current }
  }

  if (inFlightAgencRefresh) {
    return inFlightAgencRefresh
  }

  inFlightAgencRefresh = (async () => {
    const refreshAttemptedAt = Date.now()

    try {
      // @ts-expect-error -- temporary boundary: moved utility depends on not-yet-absorbed subsystem types.
      const body = new URLSearchParams({
        client_id: getAgencOAuthClientId(),
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      })

      const response = await fetch(AGENC_REFRESH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        throw new Error(getRefreshErrorMessage(response.status, bodyText))
      }

      const payload = (await response.json()) as AgencTokenRefreshResponse
      const accessToken = asTrimmedString(payload.access_token)
      if (!accessToken) {
        throw new Error(
          'Agenc token refresh succeeded without a new access token.',
        )
      }

      const next: AgencCredentialBlob = {
        accessToken,
        refreshToken:
          asTrimmedString(payload.refresh_token) ?? current.refreshToken,
        idToken: asTrimmedString(payload.id_token) ?? current.idToken,
        accountId:
          parseChatgptAccountId(payload.id_token) ??
          parseChatgptAccountId(payload.access_token) ??
          current.accountId,
        lastRefreshAt: Date.now(),
      }

      const idTokenForExchange = next.idToken ?? current.idToken
      if (idTokenForExchange) {
        next.apiKey = await exchangeAgencIdTokenForApiKey(
          idTokenForExchange,
        ).catch(() => undefined)
      }

      const saveResult = saveAgencCredentials(next)
      if (!saveResult.success) {
        throw new Error(
          saveResult.warning ??
            'Agenc token refresh succeeded but credentials could not be saved.',
        )
      }

      return {
        refreshed: true,
        credentials: next,
      }
    } catch (error) {
      persistAgencRefreshFailure(current, refreshAttemptedAt)
      throw error
    } finally {
      inFlightAgencRefresh = null
    }
  })()

  return inFlightAgencRefresh
}
