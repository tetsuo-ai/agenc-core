/**
 * Storage for the ChatGPT sign-in: the RFC 8693-exchanged platform API
 * key (long-lived — the platform path consumes it) plus the subscription
 * tokens used by accounts without a platform organization. Subscription
 * refresh is single-flight and coordinated across AgenC processes because
 * OpenAI refresh tokens rotate.
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getSecureStorage, type SecureStorageData } from './secureStorage/index.js'
import { clearKeychainCache } from './secureStorage/macOsKeychainHelpers.js'
import { getAgenCConfigHomeDir, isBareMode } from './envUtils.js'
import * as lockfile from './lockfile.js'
import {
  PROVIDER_CODE_REFRESH_URL,
  decodeJwtPayload,
  getOpenAiCodeOAuthClientId,
  normalizeOAuthTokenPayload,
} from '../services/api/openAiCodeOAuthShared.js'
import {
  CHATGPT_BACKEND_BASE_URL,
  CHATGPT_BACKEND_ORIGINATOR,
} from '../services/api/openAiChatGptBackend.js'

export {
  CHATGPT_BACKEND_BASE_URL,
  CHATGPT_BACKEND_ORIGINATOR,
}

export const OPENAI_OAUTH_STORAGE_KEY = 'openAiOauth' as const

export type OpenAiOauthCredentialBlob = NonNullable<
  SecureStorageData[typeof OPENAI_OAUTH_STORAGE_KEY]
>

const READ_CACHE_TTL_MS = 30_000
let readCache: { at: number; blob: OpenAiOauthCredentialBlob | undefined } | null =
  null

/** Bypass the process-local cache so refresh coordination sees sibling writes. */
function readOpenAiOauthCredentialsFresh():
  | OpenAiOauthCredentialBlob
  | undefined {
  if (isBareMode()) return undefined
  // getSecureStorage().read() has its own macOS cache in addition to the
  // module cache above. Invalidate it here or an under-lock "fresh" read
  // could still miss a sibling process's Keychain rotation for 30 seconds.
  clearKeychainCache()
  const data = getSecureStorage().read()
  const blob = data?.[OPENAI_OAUTH_STORAGE_KEY]
  readCache = { at: Date.now(), blob }
  return blob
}

export function readOpenAiOauthCredentials(): OpenAiOauthCredentialBlob | undefined {
  if (isBareMode()) return undefined
  if (readCache !== null && Date.now() - readCache.at < READ_CACHE_TTL_MS) {
    return readCache.blob
  }
  return readOpenAiOauthCredentialsFresh()
}

/** The exchanged platform API key, when signed in. */
export function readOpenAiOauthApiKey(): string | undefined {
  const blob = readOpenAiOauthCredentials()
  const key = blob?.apiKey?.trim()
  return key !== undefined && key.length > 0 ? key : undefined
}

/**
 * The ChatGPT backend that a subscription sign-in talks to. Requests go
 * to `{base}/responses` with the access token as the bearer and the
 * account id in a header — no platform API key is involved, which is why
 * this path works for accounts that have no platform organization.
 */
export interface OpenAiSubscriptionAuth {
  readonly accessToken: string
  readonly accountId: string
  readonly baseUrl: string
  readonly accountLabel?: string
}

/**
 * Subscription credentials, when the sign-in produced tokens but no
 * platform API key. Returns undefined when a real API key exists — that
 * path is simpler and takes precedence.
 */
export function readOpenAiSubscriptionAuth():
  | OpenAiSubscriptionAuth
  | undefined {
  const blob = readOpenAiOauthCredentials()
  if (blob === undefined) return undefined
  if (blob.apiKey?.trim()) return undefined
  const accessToken = blob.accessToken?.trim()
  const accountId = blob.accountId?.trim()
  if (!accessToken || !accountId) return undefined
  return {
    accessToken,
    accountId,
    baseUrl: CHATGPT_BACKEND_BASE_URL,
    ...(blob.accountLabel !== undefined
      ? { accountLabel: blob.accountLabel }
      : {}),
  }
}

export function saveOpenAiOauthCredentials(
  blob: OpenAiOauthCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  // Either credential shape is valid: a platform API key, or the
  // subscription pair the ChatGPT backend authenticates with.
  const hasApiKey = Boolean(blob.apiKey?.trim())
  const hasSubscription =
    Boolean(blob.accessToken?.trim()) && Boolean(blob.accountId?.trim())
  if (!hasApiKey && !hasSubscription) {
    return {
      success: false,
      warning: 'No API key and no ChatGPT subscription tokens to store.',
    }
  }
  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() ?? {}
  const result = secureStorage.update({
    ...prev,
    [OPENAI_OAUTH_STORAGE_KEY]: blob,
  })
  if (result.success) {
    readCache = { at: Date.now(), blob }
  }
  return result
}

export interface RefreshOpenAiSubscriptionOptions {
  readonly nowMs?: number
  readonly windowMs?: number
}

const OPENAI_OAUTH_REFRESH_TIMEOUT_MS = 10_000
let inflightSubscriptionRefresh: Promise<boolean> | null = null

function isSubscriptionBlob(
  blob: OpenAiOauthCredentialBlob | undefined,
): blob is OpenAiOauthCredentialBlob {
  return (
    blob !== undefined &&
    !blob.apiKey?.trim() &&
    Boolean(blob.accessToken?.trim()) &&
    Boolean(blob.accountId?.trim()) &&
    Boolean(blob.refreshToken?.trim())
  )
}

function sameSubscriptionGrant(
  left: OpenAiOauthCredentialBlob,
  right: OpenAiOauthCredentialBlob,
): boolean {
  return (
    left.accessToken?.trim() === right.accessToken?.trim() &&
    left.refreshToken?.trim() === right.refreshToken?.trim() &&
    left.accountId?.trim() === right.accountId?.trim() &&
    !right.apiKey?.trim()
  )
}

function subscriptionChangedFrom(
  current: OpenAiOauthCredentialBlob | undefined,
  previous: OpenAiOauthCredentialBlob,
): boolean {
  return isSubscriptionBlob(current) && !sameSubscriptionGrant(current, previous)
}

async function acquireOpenAiRefreshLock(): Promise<
  (() => Promise<void>) | null
> {
  try {
    // macOS keeps the legacy Keychain service global whenever
    // AGENC_CONFIG_DIR is unset, even if AGENC_HOME differs. Use the same
    // legacy-global lock namespace so those processes cannot rotate one
    // shared refresh token concurrently.
    const dir = process.env.AGENC_CONFIG_DIR
      ? getAgenCConfigHomeDir()
      : join(homedir(), '.agenc')
    await mkdir(dir, { recursive: true })
    return await lockfile.lock(join(dir, '.openai-oauth-refresh'), {
      realpath: false,
      stale: 30_000,
      retries: { retries: 5, minTimeout: 200, maxTimeout: 2_000 },
    })
  } catch {
    // Refresh tokens rotate. Proceeding without the cross-process lock could
    // let two processes consume the same grant and invalidate the credential
    // family even if later storage conflict checks prevent an overwrite.
    return null
  }
}

async function performOpenAiSubscriptionRefresh(args: {
  readonly initial: OpenAiOauthCredentialBlob
  readonly now: number
}): Promise<boolean> {
  // The caller may have populated the 30s read cache before a sibling
  // process rotated the grant. Adopt that rotation without replaying its
  // now-consumed refresh token.
  const beforeLock = readOpenAiOauthCredentialsFresh()
  if (subscriptionChangedFrom(beforeLock, args.initial)) return true
  if (!isSubscriptionBlob(beforeLock)) return false

  const release = await acquireOpenAiRefreshLock()
  if (release === null) return false
  try {
    const current = readOpenAiOauthCredentialsFresh()
    if (subscriptionChangedFrom(current, args.initial)) return true
    if (!isSubscriptionBlob(current)) return false

    let response: Response
    try {
      response = await fetch(PROVIDER_CODE_REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: getOpenAiCodeOAuthClientId(),
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken!.trim(),
        }),
        signal: AbortSignal.timeout(OPENAI_OAUTH_REFRESH_TIMEOUT_MS),
      })
    } catch {
      return subscriptionChangedFrom(
        readOpenAiOauthCredentialsFresh(),
        current,
      )
    }
    if (!response.ok) {
      return subscriptionChangedFrom(
        readOpenAiOauthCredentialsFresh(),
        current,
      )
    }

    let payload: ReturnType<typeof normalizeOAuthTokenPayload>
    try {
      payload = normalizeOAuthTokenPayload(await response.json())
    } catch {
      return subscriptionChangedFrom(
        readOpenAiOauthCredentialsFresh(),
        current,
      )
    }
    if (!payload.accessToken) {
      return subscriptionChangedFrom(
        readOpenAiOauthCredentialsFresh(),
        current,
      )
    }

    // Login/logout are not required to take the refresh lock. Re-read just
    // before persistence so a response to an older grant cannot resurrect a
    // logout or overwrite a newer login that landed while POST was in flight.
    const latest = readOpenAiOauthCredentialsFresh()
    if (!isSubscriptionBlob(latest)) return false
    if (!sameSubscriptionGrant(latest, current)) return true

    const saved = saveOpenAiOauthCredentials({
      ...latest,
      accessToken: payload.accessToken,
      ...(payload.idToken ? { idToken: payload.idToken } : {}),
      // Refresh tokens rotate; reusing a spent one is rejected.
      ...(payload.refreshToken ? { refreshToken: payload.refreshToken } : {}),
      obtainedAt: args.now,
    })
    return saved.success
  } finally {
    // The credential may already be durably rotated. A cleanup error must not
    // turn that success into `false` at the caller and leave its live bearer
    // on the now-stale token.
    try {
      await release()
    } catch {
      // The lock implementation owns stale-lock recovery on the next attempt.
    }
  }
}

/**
 * Refresh the subscription access token when it is close to expiring.
 * Returns true when this process updated the credential or adopted a newer
 * sibling-process grant, so callers know to re-read and swap their bearer.
 */
export function refreshOpenAiSubscriptionIfNeeded(
  options?: RefreshOpenAiSubscriptionOptions,
): Promise<boolean> {
  const blob = readOpenAiOauthCredentials()
  if (!isSubscriptionBlob(blob)) return Promise.resolve(false)

  const now = options?.nowMs ?? Date.now()
  const window = options?.windowMs ?? 5 * 60_000
  const expiresAt = jwtExpiryMs(blob.accessToken)
  if (expiresAt !== undefined && expiresAt - window > now) {
    return Promise.resolve(false)
  }

  if (inflightSubscriptionRefresh !== null) {
    return inflightSubscriptionRefresh
  }
  inflightSubscriptionRefresh = performOpenAiSubscriptionRefresh({
    initial: blob,
    now,
  }).finally(() => {
    inflightSubscriptionRefresh = null
  })
  return inflightSubscriptionRefresh
}

/** `exp` from a JWT payload, in ms. Undefined when unreadable. */
function jwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined
  const claims = decodeJwtPayload(token)
  const exp = claims?.['exp']
  return typeof exp === 'number' ? exp * 1000 : undefined
}

export function clearOpenAiOauthCredentials(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) return { success: true }
  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() ?? {}
  const next = { ...prev }
  delete next[OPENAI_OAUTH_STORAGE_KEY]
  const result = secureStorage.update(next)
  if (result.success) {
    readCache = { at: Date.now(), blob: undefined }
  }
  return result
}
