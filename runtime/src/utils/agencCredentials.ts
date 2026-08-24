import { isBareMode } from './envUtils.js'
import type { HomeContext } from '../config/home.js'
import type { SecureStorageData } from './secureStorage/index.js'
import {
  NativeSecureStorageError,
  readNativeSecureStorage,
  readNativeSecureStorageAsync,
  updateNativeSecureStorage,
} from './secureStorage/native.js'
import { nativeVaultIdentityKey } from './secureStorage/home.js'
import {
  asTrimmedString,
  PROVIDER_CODE_REFRESH_URL as AGENC_REFRESH_URL,
  exchangeProviderCodeIdTokenForApiKey as exchangeAgencIdTokenForApiKey,
  getOpenAiCodeOAuthClientId as getAgencOAuthClientId,
  normalizeOAuthTokenPayload,
  parseChatgptAccountId,
  decodeJwtPayload,
  readOAuthTokenJsonResponse,
} from '../services/api/openAiCodeOAuthShared.js'
import type { ProviderEnvironment } from '../llm/provider-options.js'
import { getProxyFetchOptions } from './proxy.js'

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

interface AgencRefreshState {
  inFlightByEnvironment: WeakMap<object, Promise<AgencRefreshResult>>
  lastRefreshFailureAt: number | null
}

interface AgencRefreshResult {
  refreshed: boolean
  credentials?: AgencCredentialBlob
}

const refreshStateByHome = new Map<string, AgencRefreshState>()

function refreshState(home: HomeContext): AgencRefreshState {
  const vaultIdentity = nativeVaultIdentityKey(home)
  const existing = refreshStateByHome.get(vaultIdentity)
  if (existing) return existing
  const created: AgencRefreshState = {
    inFlightByEnvironment: new WeakMap(),
    lastRefreshFailureAt: null,
  }
  refreshStateByHome.set(vaultIdentity, created)
  return created
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

export class AgencCredentialConflictError extends Error {
  readonly name = 'AgencCredentialConflictError'

  constructor() {
    super(
      'AgenC credentials changed while an OAuth refresh was in flight; the newer native-vault value was preserved.',
    )
  }
}

function sameCredentials(
  left: AgencCredentialBlob,
  right: AgencCredentialBlob,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function writeAgencCredentials(
  home: HomeContext,
  credentials: AgencCredentialBlob,
  expected?: AgencCredentialBlob,
): AgencCredentialBlob {
  let stored: AgencCredentialBlob | undefined
  updateNativeSecureStorage(
    home,
    current => {
      const previous = normalizeAgencCredentialBlob(current[AGENC_STORAGE_KEY])
      if (
        expected !== undefined &&
        (previous === undefined || !sameCredentials(previous, expected))
      ) {
        throw new AgencCredentialConflictError()
      }
      stored = {
        ...credentials,
        profileId: credentials.profileId ?? previous?.profileId,
        lastRefreshAt: credentials.lastRefreshAt ?? Date.now(),
      }
      return {
        ...current,
        [AGENC_STORAGE_KEY]: stored,
      }
    },
    'Native secure storage is unavailable; AgenC credentials were not saved.',
  )
  if (stored === undefined) {
    throw new NativeSecureStorageError(
      'Native secure storage did not accept AgenC credentials.',
    )
  }
  return stored
}

function secureStorageFailure(error: unknown): {
  success: false
  warning: string
} {
  return {
    success: false,
    warning:
      error instanceof Error
        ? error.message
        : 'Native secure storage operation failed.',
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
  inMemoryLastRefreshFailureAt: number | null,
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

export function readAgencCredentials(
  home: HomeContext,
): AgencCredentialBlob | undefined {
  if (isBareMode()) return undefined

  try {
    const data = readNativeSecureStorage(home)
    return normalizeAgencCredentialBlob(data?.agenc)
  } catch {
    return undefined
  }
}

export async function readAgencCredentialsAsync(
  home: HomeContext,
): Promise<
  AgencCredentialBlob | undefined
> {
  if (isBareMode()) return undefined

  try {
    const data = await readNativeSecureStorageAsync(home)
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
    null,
    now,
  )
}

export function saveAgencCredentials(
  home: HomeContext,
  credentials: AgencCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const normalized = normalizeAgencCredentialBlob(credentials)
  if (!normalized) {
    return { success: false, warning: 'Agenc credentials are incomplete.' }
  }

  try {
    const stored = writeAgencCredentials(home, normalized)
    refreshState(home).lastRefreshFailureAt =
      stored.lastRefreshFailureAt ?? null
    return { success: true }
  } catch (error) {
    return secureStorageFailure(error)
  }
}

export function attachAgencProfileIdToStoredCredentials(
  home: HomeContext,
  profileId: string,
): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  try {
    let found = false
    updateNativeSecureStorage(
      home,
      current => {
        const credentials = normalizeAgencCredentialBlob(current.agenc)
        if (!credentials) return structuredClone(current) as SecureStorageData
        found = true
        return {
          ...current,
          agenc: { ...credentials, profileId },
        }
      },
      'Native secure storage is unavailable; AgenC profile linkage was not saved.',
    )
    return found
      ? { success: true }
      : {
          success: false,
          warning: 'Agenc credentials are not stored securely yet.',
        }
  } catch (error) {
    return secureStorageFailure(error)
  }
}

function persistAgencRefreshFailure(
  home: HomeContext,
  credentials: AgencCredentialBlob,
  occurredAt: number,
): void {
  const state = refreshState(home)
  try {
    updateNativeSecureStorage(
      home,
      current => {
        const stored = normalizeAgencCredentialBlob(current.agenc)
        if (!stored || !sameCredentials(stored, credentials)) {
          return structuredClone(current) as SecureStorageData
        }
        return {
          ...current,
          agenc: { ...stored, lastRefreshFailureAt: occurredAt },
        }
      },
      'Native secure storage is unavailable; AgenC refresh cooldown was not saved.',
    )
  } catch {
    // The in-memory cooldown still prevents a hot retry loop in this process.
  }
  state.lastRefreshFailureAt = occurredAt
}

export function clearAgencCredentials(home: HomeContext): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: true }
  }

  try {
    updateNativeSecureStorage(
      home,
      current => {
        const next = { ...current }
        delete next[AGENC_STORAGE_KEY]
        return next
      },
      'Native secure storage is unavailable; AgenC credentials were not cleared.',
    )
    refreshState(home).lastRefreshFailureAt = null
    return { success: true }
  } catch (error) {
    return secureStorageFailure(error)
  }
}

export async function refreshAgencAccessTokenIfNeeded(
  home: HomeContext,
  environment: ProviderEnvironment,
  options?: {
    force?: boolean
  },
): Promise<AgencRefreshResult> {
  if (isBareMode()) {
    return { refreshed: false }
  }

  if (
    environment.PROVIDER_CODE_API_KEY?.trim() ||
    environment.AGENC_API_KEY?.trim()
  ) {
    return { refreshed: false }
  }

  const current = await readAgencCredentialsAsync(home)
  if (!current) {
    return { refreshed: false }
  }

  if (!current.refreshToken) {
    return { refreshed: false, credentials: current }
  }
  const refreshToken = current.refreshToken

  if (!options?.force && !shouldRefreshAgencToken(current)) {
    return { refreshed: false, credentials: current }
  }

  const state = refreshState(home)
  if (
    !options?.force &&
    isWithinRefreshFailureCooldown(current, state.lastRefreshFailureAt)
  ) {
    return { refreshed: false, credentials: current }
  }

  const existingRefresh = state.inFlightByEnvironment.get(environment)
  if (existingRefresh) {
    return existingRefresh
  }

  const inFlight = Promise.resolve().then(async () => {
    const refreshAttemptedAt = Date.now()

    try {
      const body = new URLSearchParams({
        client_id: getAgencOAuthClientId(environment),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })

      const response = await fetch(AGENC_REFRESH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(15_000),
        ...getProxyFetchOptions({ environment }),
      })

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        throw new Error(getRefreshErrorMessage(response.status, bodyText))
      }

      const payload = normalizeOAuthTokenPayload(
        await readOAuthTokenJsonResponse(response, 'Agenc token refresh'),
      )
      const accessToken = payload.accessToken
      if (!accessToken) {
        throw new Error(
          'Agenc token refresh succeeded without a new access token.',
        )
      }

      const next: AgencCredentialBlob = {
        accessToken,
        refreshToken:
          payload.refreshToken ?? refreshToken,
        idToken: payload.idToken ?? current.idToken,
        accountId:
          parseChatgptAccountId(payload.idToken) ??
          parseChatgptAccountId(payload.accessToken) ??
          current.accountId,
        lastRefreshAt: Date.now(),
      }

      const idTokenForExchange = next.idToken ?? current.idToken
      if (idTokenForExchange) {
        next.apiKey = await exchangeAgencIdTokenForApiKey(
          idTokenForExchange,
          environment,
        ).catch(() => undefined)
      }

      try {
        writeAgencCredentials(home, next, current)
      } catch (error) {
        if (error instanceof AgencCredentialConflictError) {
          return {
            refreshed: false,
            credentials: await readAgencCredentialsAsync(home),
          }
        }
        throw error
      }

      return {
        refreshed: true,
        credentials: next,
      }
    } catch (error) {
      persistAgencRefreshFailure(home, current, refreshAttemptedAt)
      throw error
    } finally {
      state.inFlightByEnvironment.delete(environment)
    }
  })

  state.inFlightByEnvironment.set(environment, inFlight)
  return inFlight
}
