// @ts-nocheck
import { isBareMode } from './envUtils.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  asTrimmedString,
  CODEX_REFRESH_URL as AGENC_REFRESH_URL,
  exchangeCodexIdTokenForApiKey,
  getCodexOAuthClientId,
  parseChatgptAccountId,
  decodeJwtPayload,
} from '../services/api/agencOAuthShared.js'

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

let inFlightCodexRefresh:
  | Promise<{
      refreshed: boolean
      credentials?: AgencCredentialBlob
    }>
  | null = null
let inMemoryLastRefreshFailureAt: number | null = null

function getCodexSecureStorage() {
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

function normalizeCodexCredentialBlob(
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

function shouldRefreshCodexToken(blob: AgencCredentialBlob): boolean {
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

export function readCodexCredentials(): AgencCredentialBlob | undefined {
  if (isBareMode()) return undefined

  try {
    const data = getCodexSecureStorage().read()
    return normalizeCodexCredentialBlob(data?.agenc)
  } catch {
    return undefined
  }
}

export async function readCodexCredentialsAsync(): Promise<
  AgencCredentialBlob | undefined
> {
  if (isBareMode()) return undefined

  try {
    const data = await getCodexSecureStorage().readAsync()
    return normalizeCodexCredentialBlob(data?.agenc)
  } catch {
    return undefined
  }
}

export function isCodexRefreshFailureCoolingDown(
  blob: Pick<AgencCredentialBlob, 'lastRefreshFailureAt'>,
  now = Date.now(),
): boolean {
  return isWithinRefreshFailureCooldown(
    blob as AgencCredentialBlob,
    now,
  )
}

export function saveCodexCredentials(
  credentials: AgencCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const normalized = normalizeCodexCredentialBlob(credentials)
  if (!normalized) {
    return { success: false, warning: 'Agenc credentials are incomplete.' }
  }

  const secureStorage = getCodexSecureStorage()
  const previous = secureStorage.read() || {}
  const previousCodex = normalizeCodexCredentialBlob(previous[AGENC_STORAGE_KEY])
  const next = {
    ...(previous as Record<string, unknown>),
    [AGENC_STORAGE_KEY]: {
      ...normalized,
      profileId: normalized.profileId ?? previousCodex?.profileId,
      lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
    },
  }
  const result = secureStorage.update(next as typeof previous)
  if (result.success) {
    const storedCodex = normalizeCodexCredentialBlob(next[AGENC_STORAGE_KEY])
    inMemoryLastRefreshFailureAt = storedCodex?.lastRefreshFailureAt ?? null
  }
  return result
}

export function attachCodexProfileIdToStoredCredentials(profileId: string): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const current = readCodexCredentials()
  if (!current) {
    return {
      success: false,
      warning: 'Agenc credentials are not stored securely yet.',
    }
  }

  return saveCodexCredentials({
    ...current,
    profileId,
  })
}

function persistCodexRefreshFailure(
  credentials: AgencCredentialBlob,
  occurredAt: number,
): void {
  const result = saveCodexCredentials({
    ...credentials,
    lastRefreshFailureAt: occurredAt,
  })
  if (!result.success) {
    inMemoryLastRefreshFailureAt = occurredAt
  }
}

export function clearCodexCredentials(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: true }
  }

  const secureStorage = getCodexSecureStorage()
  const previous = secureStorage.read() || {}
  const next = { ...(previous as Record<string, unknown>) }
  delete next[AGENC_STORAGE_KEY]
  const result = secureStorage.update(next as typeof previous)
  if (result.success) {
    inMemoryLastRefreshFailureAt = null
  }
  return result
}

export async function refreshCodexAccessTokenIfNeeded(options?: {
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

  const current = await readCodexCredentialsAsync()
  if (!current) {
    return { refreshed: false }
  }

  if (!current.refreshToken) {
    return { refreshed: false, credentials: current }
  }

  if (!options?.force && !shouldRefreshCodexToken(current)) {
    return { refreshed: false, credentials: current }
  }

  if (!options?.force && isWithinRefreshFailureCooldown(current)) {
    return { refreshed: false, credentials: current }
  }

  if (inFlightCodexRefresh) {
    return inFlightCodexRefresh
  }

  inFlightCodexRefresh = (async () => {
    const refreshAttemptedAt = Date.now()

    try {
      const body = new URLSearchParams({
        client_id: getCodexOAuthClientId(),
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
        next.apiKey = await exchangeCodexIdTokenForApiKey(
          idTokenForExchange,
        ).catch(() => undefined)
      }

      const saveResult = saveCodexCredentials(next)
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
      persistCodexRefreshFailure(current, refreshAttemptedAt)
      throw error
    } finally {
      inFlightCodexRefresh = null
    }
  })()

  return inFlightCodexRefresh
}
