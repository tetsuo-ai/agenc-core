/** Canonical native secure storage repository for OpenAI/ChatGPT sign-in credentials. */

import type { HomeContext } from '../config/home.js'
import type { ProviderEnvironment } from '../llm/provider-options.js'
import {
  PROVIDER_CODE_REFRESH_URL,
  decodeJwtPayload,
  getOpenAiCodeOAuthClientId,
  normalizeOAuthTokenPayload,
  parseChatgptAccountId,
  readOAuthTokenJsonResponse,
} from '../services/api/openAiCodeOAuthShared.js'
import { getProxyFetchOptions } from './proxy.js'
import type { SecureStorageData } from './secureStorage/index.js'
import {
  NativeSecureStorageError,
  readNativeSecureStorage,
  readNativeSecureStorageAsync,
  updateNativeSecureStorage,
} from './secureStorage/native.js'
import { secureStorageIdentityKey } from './secureStorage/home.js'

export const OPENAI_OAUTH_STORAGE_KEY = 'openAiOauth' as const

export type OpenAiOauthCredentialBlob = NonNullable<
  SecureStorageData[typeof OPENAI_OAUTH_STORAGE_KEY]
>

export interface OpenAiOauthRefreshResult {
  readonly refreshed: boolean
  readonly credentials?: OpenAiOauthCredentialBlob
}

export interface RefreshOpenAiSubscriptionOptions {
  readonly force?: boolean
  readonly nowMs?: number
  readonly windowMs?: number
}

interface OpenAiRefreshState {
  readonly inFlightByEnvironment: WeakMap<
    object,
    Promise<OpenAiOauthRefreshResult>
  >
  lastRefreshFailureAt: number | null
}

const READ_CACHE_TTL_MS = 30_000
const REFRESH_WINDOW_MS = 5 * 60_000
const REFRESH_FAILURE_COOLDOWN_MS = 60_000

const readCacheByStorageIdentity = new Map<
  string,
  {
    readonly at: number
    readonly blob: OpenAiOauthCredentialBlob | undefined
  }
>()
const refreshStateByStorageIdentity = new Map<string, OpenAiRefreshState>()

export class OpenAiOauthCredentialConflictError extends Error {
  readonly name = 'OpenAiOauthCredentialConflictError'

  constructor() {
    super(
      'OpenAI credentials changed while an OAuth refresh was in flight; ' +
        'the newer native secure storage value was preserved.',
    )
  }
}

function credentialString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function normalizeOpenAiOauthCredentialBlob(
  value: unknown,
): OpenAiOauthCredentialBlob | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const apiKey = credentialString(record.apiKey)
  const accessToken = credentialString(record.accessToken)
  const idToken = credentialString(record.idToken)
  const refreshToken = credentialString(record.refreshToken)
  const accountId =
    credentialString(record.accountId) ??
    parseChatgptAccountId(idToken) ??
    parseChatgptAccountId(accessToken)
  const accountLabel = credentialString(record.accountLabel)
  const obtainedAt = finiteTimestamp(record.obtainedAt)
  const lastRefreshAt = finiteTimestamp(record.lastRefreshAt)
  const lastRefreshFailureAt = finiteTimestamp(record.lastRefreshFailureAt)

  const hasPlatformCredential = apiKey !== undefined
  const hasSubscriptionCredential =
    accessToken !== undefined && accountId !== undefined
  if (!hasPlatformCredential && !hasSubscriptionCredential) return undefined

  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    authMode: apiKey !== undefined ? 'apiKey' : 'chatgpt',
    ...(accessToken !== undefined ? { accessToken } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(accountLabel !== undefined ? { accountLabel } : {}),
    ...(idToken !== undefined ? { idToken } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(obtainedAt !== undefined ? { obtainedAt } : {}),
    ...(lastRefreshAt !== undefined ? { lastRefreshAt } : {}),
    ...(lastRefreshFailureAt !== undefined
      ? { lastRefreshFailureAt }
      : {}),
  }
}

function sameCredentials(
  left: OpenAiOauthCredentialBlob | undefined,
  right: OpenAiOauthCredentialBlob | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function updateReadCache(
  home: HomeContext,
  blob: OpenAiOauthCredentialBlob | undefined,
): void {
  readCacheByStorageIdentity.set(secureStorageIdentityKey(home), {
    at: Date.now(),
    blob: blob === undefined ? undefined : structuredClone(blob),
  })
}

function readOpenAiOauthCredentialsFresh(
  home: HomeContext,
): OpenAiOauthCredentialBlob | undefined {
  const blob = normalizeOpenAiOauthCredentialBlob(
    readNativeSecureStorage(home)[OPENAI_OAUTH_STORAGE_KEY],
  )
  updateReadCache(home, blob)
  return blob === undefined ? undefined : structuredClone(blob)
}

export function readOpenAiOauthCredentials(
  home: HomeContext,
): OpenAiOauthCredentialBlob | undefined {
  const cached = readCacheByStorageIdentity.get(secureStorageIdentityKey(home))
  if (cached !== undefined && Date.now() - cached.at < READ_CACHE_TTL_MS) {
    return cached.blob === undefined
      ? undefined
      : structuredClone(cached.blob)
  }
  return readOpenAiOauthCredentialsFresh(home)
}

export async function readOpenAiOauthCredentialsAsync(
  home: HomeContext,
): Promise<OpenAiOauthCredentialBlob | undefined> {
  const blob = normalizeOpenAiOauthCredentialBlob(
    (await readNativeSecureStorageAsync(home))[OPENAI_OAUTH_STORAGE_KEY],
  )
  updateReadCache(home, blob)
  return blob === undefined ? undefined : structuredClone(blob)
}

export function readOpenAiOauthApiKey(
  home: HomeContext,
): string | undefined {
  return readOpenAiOauthCredentials(home)?.apiKey
}

function writeOpenAiOauthCredentials(
  home: HomeContext,
  credentials: OpenAiOauthCredentialBlob,
  expected?: OpenAiOauthCredentialBlob,
): OpenAiOauthCredentialBlob {
  const normalized = normalizeOpenAiOauthCredentialBlob(credentials)
  if (normalized === undefined) {
    throw new NativeSecureStorageError(
      'OpenAI credentials are incomplete and were not saved.',
    )
  }
  let written: OpenAiOauthCredentialBlob | undefined
  updateNativeSecureStorage(
    home,
    current => {
      const previous = normalizeOpenAiOauthCredentialBlob(
        current[OPENAI_OAUTH_STORAGE_KEY],
      )
      if (expected !== undefined && !sameCredentials(previous, expected)) {
        throw new OpenAiOauthCredentialConflictError()
      }
      written = structuredClone(normalized)
      return {
        ...current,
        [OPENAI_OAUTH_STORAGE_KEY]: written,
      }
    },
    'Native secure storage is unavailable; OpenAI credentials were not saved.',
  )
  if (written === undefined) {
    throw new NativeSecureStorageError(
      'Native secure storage did not accept OpenAI credentials.',
    )
  }
  updateReadCache(home, written)
  return structuredClone(written)
}

function secureStorageFailure(error: unknown): {
  readonly success: false
  readonly warning: string
} {
  return {
    success: false,
    warning:
      error instanceof Error
        ? error.message
        : 'Native secure storage operation failed.',
  }
}

export function saveOpenAiOauthCredentials(
  home: HomeContext,
  blob: OpenAiOauthCredentialBlob,
): { success: boolean; warning?: string } {
  try {
    writeOpenAiOauthCredentials(home, blob)
    return { success: true }
  } catch (error) {
    return secureStorageFailure(error)
  }
}

export function clearOpenAiOauthCredentials(
  home: HomeContext,
): { success: boolean; warning?: string } {
  try {
    updateNativeSecureStorage(
      home,
      current => {
        const next = { ...current }
        delete next[OPENAI_OAUTH_STORAGE_KEY]
        return next
      },
      'Native secure storage is unavailable; OpenAI credentials were not cleared.',
    )
    updateReadCache(home, undefined)
    refreshState(home).lastRefreshFailureAt = null
    return { success: true }
  } catch (error) {
    return secureStorageFailure(error)
  }
}

function refreshState(home: HomeContext): OpenAiRefreshState {
  const storageIdentity = secureStorageIdentityKey(home)
  const existing = refreshStateByStorageIdentity.get(storageIdentity)
  if (existing !== undefined) return existing
  const created: OpenAiRefreshState = {
    inFlightByEnvironment: new WeakMap(),
    lastRefreshFailureAt: null,
  }
  refreshStateByStorageIdentity.set(storageIdentity, created)
  return created
}

function jwtExpiryMs(token: string | undefined): number | undefined {
  if (token === undefined) return undefined
  const exp = decodeJwtPayload(token)?.exp
  return typeof exp === 'number' && Number.isFinite(exp)
    ? exp * 1000
    : undefined
}

function refreshIsCoolingDown(
  blob: OpenAiOauthCredentialBlob,
  state: OpenAiRefreshState,
  now: number,
): boolean {
  const lastFailure = Math.max(
    blob.lastRefreshFailureAt ?? 0,
    state.lastRefreshFailureAt ?? 0,
  )
  return lastFailure > 0 && now - lastFailure < REFRESH_FAILURE_COOLDOWN_MS
}

function shouldRefresh(
  blob: OpenAiOauthCredentialBlob,
  now: number,
  windowMs: number,
): boolean {
  const expiresAt = jwtExpiryMs(blob.accessToken)
  return expiresAt !== undefined && expiresAt <= now + windowMs
}

function refreshErrorMessage(status: number, bodyText: string): string {
  if (bodyText.trim().length === 0) {
    return `OpenAI token refresh failed with status ${status}.`
  }
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const nested =
      parsed.error && typeof parsed.error === 'object'
        ? (parsed.error as Record<string, unknown>)
        : undefined
    const code = credentialString(nested?.code ?? parsed.code)
    const message =
      credentialString(nested?.message ?? parsed.error_description) ??
      bodyText.trim()
    return code === undefined
      ? `OpenAI token refresh failed with status ${status}: ${message}`
      : `OpenAI token refresh failed (${code}): ${message}`
  } catch {
    return `OpenAI token refresh failed with status ${status}: ${bodyText.trim()}`
  }
}

function withoutRefreshFailure(
  blob: OpenAiOauthCredentialBlob,
): OpenAiOauthCredentialBlob {
  const next = { ...blob }
  delete next.lastRefreshFailureAt
  return next
}

function compareAndSetOpenAiOauthCredentials(
  home: HomeContext,
  expected: OpenAiOauthCredentialBlob,
  replacement: OpenAiOauthCredentialBlob,
): OpenAiOauthCredentialBlob | undefined {
  try {
    return writeOpenAiOauthCredentials(home, replacement, expected)
  } catch (error) {
    if (error instanceof OpenAiOauthCredentialConflictError) {
      return readOpenAiOauthCredentialsFresh(home)
    }
    throw error
  }
}

function persistRefreshFailure(
  home: HomeContext,
  expected: OpenAiOauthCredentialBlob,
  occurredAt: number,
): void {
  const state = refreshState(home)
  state.lastRefreshFailureAt = occurredAt
  try {
    const replacement: OpenAiOauthCredentialBlob = {
      ...expected,
      lastRefreshFailureAt: occurredAt,
    }
    compareAndSetOpenAiOauthCredentials(home, expected, replacement)
  } catch {
    // The in-memory timestamp still prevents a hot refresh loop in this process.
  }
}

export async function refreshOpenAiSubscriptionIfNeeded(
  home: HomeContext,
  environment: ProviderEnvironment,
  options: RefreshOpenAiSubscriptionOptions = {},
): Promise<OpenAiOauthRefreshResult> {
  const current = await readOpenAiOauthCredentialsAsync(home)
  if (current === undefined) {
    return { refreshed: false }
  }
  const refreshToken = credentialString(current.refreshToken)
  const accessToken = credentialString(current.accessToken)
  const accountId = credentialString(current.accountId)
  if (
    refreshToken === undefined ||
    accessToken === undefined ||
    accountId === undefined
  ) {
    return { refreshed: false, credentials: current }
  }

  const now = options.nowMs ?? Date.now()
  const windowMs = options.windowMs ?? REFRESH_WINDOW_MS
  if (options.force !== true && !shouldRefresh(current, now, windowMs)) {
    return { refreshed: false, credentials: current }
  }
  const state = refreshState(home)
  if (refreshIsCoolingDown(current, state, now)) {
    return { refreshed: false, credentials: current }
  }

  const existing = state.inFlightByEnvironment.get(environment)
  if (existing !== undefined) return existing

  const inFlight = Promise.resolve().then(async () => {
    const attemptedAt = options.nowMs ?? Date.now()
    try {
      const body = new URLSearchParams({
        client_id: getOpenAiCodeOAuthClientId(environment),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })
      const response = await fetch(PROVIDER_CODE_REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(30_000),
        ...getProxyFetchOptions({ environment }),
      })
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        throw new Error(refreshErrorMessage(response.status, bodyText))
      }
      const payload = normalizeOAuthTokenPayload(
        await readOAuthTokenJsonResponse(response, 'OpenAI token refresh'),
      )
      if (payload.accessToken === undefined) {
        throw new Error(
          'OpenAI token refresh succeeded without a new access token.',
        )
      }

      const next: OpenAiOauthCredentialBlob = {
        ...withoutRefreshFailure(current),
        authMode: current.apiKey === undefined ? 'chatgpt' : 'apiKey',
        accessToken: payload.accessToken,
        accountId:
          parseChatgptAccountId(payload.idToken) ??
          parseChatgptAccountId(payload.accessToken) ??
          accountId,
        idToken: payload.idToken ?? current.idToken,
        refreshToken: payload.refreshToken ?? refreshToken,
        lastRefreshAt: attemptedAt,
      }
      const written = compareAndSetOpenAiOauthCredentials(
        home,
        current,
        next,
      )
      state.lastRefreshFailureAt = null
      if (written === undefined) {
        return {
          refreshed: false,
        }
      }
      return {
        refreshed: sameCredentials(written, next),
        credentials: written,
      }
    } catch (error) {
      persistRefreshFailure(home, current, attemptedAt)
      throw error
    } finally {
      state.inFlightByEnvironment.delete(environment)
    }
  })

  state.inFlightByEnvironment.set(environment, inFlight)
  return inFlight
}
