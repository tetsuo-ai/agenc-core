import { createHash } from 'node:crypto'
import { mkdir } from 'fs/promises'
import { join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { AGENC_AI_PROFILE_SCOPE } from 'src/constants/oauth.js'
import {
  getAPIProvider,
  getSelectedProviderName,
} from 'src/utils/model/providers.js'
import { preferThirdPartyAuthentication } from '../bootstrap/state.js'


// Donor-purge stub: ../services/oauth/types.js was deleted along with the
// upstream oauth service. Keep the consumed shapes as opaque aliases.
type OAuthTokens = any
type SubscriptionType = any
import {
  getApiKeyFromFileDescriptor,
  getOAuthTokenFromFileDescriptor,
} from './authFileDescriptor.js'
import {
  isEnvTruthy,
  isRunningOnHomespace,
} from './envUtils.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import {
  type OAuthAccountMetadata,
  type SecureStorageData,
} from './secureStorage/index.js'
import {
  readNativeSecureStorage,
  readNativeSecureStorageAsync,
  updateNativeSecureStorage,
} from './secureStorage/native.js'
import type { HomeContext } from '../config/home.js'
import {
  secureStorageIdentityKey,
  resolveSecureStorageHome,
} from './secureStorage/home.js'
import { getSelectedProviderEnvironment } from './model/providers.js'
import {
  clearKeychainCache,
} from './secureStorage/macOsKeychainHelpers.js'
import { getSettingsForSource } from './settings/settings.js'
import { sleep } from './sleep.js'
import { isSessionRemoteMode } from '../session/runtime-options.js'
import type { ProviderEnvironment } from '../llm/provider-options.js'

// ---- donor-purge stubs ----
// These symbols used to come from modules deleted in the api.anthropic.com
// purge. They are stubbed here as no-ops so the surrounding moved-source
// code paths degrade silently. Real implementations land when AgenC ships
// the equivalent backend.
const getOauthProfileFromOauthToken = async (
  ..._args: unknown[]
): Promise<any> => null;
const isOAuthTokenExpired = (..._args: unknown[]): boolean => true;
const refreshOAuthToken = async (..._args: unknown[]): Promise<null> => null;
const shouldUseAgenCAIAuth = (..._args: unknown[]): boolean => false;
// ---- end donor-purge stubs ----
function normalizeApiKeyForConfig(apiKey: string): string {
  return `sha256:${createHash('sha256').update(apiKey).digest('hex')}`
}

function currentNativeHome() {
  return resolveSecureStorageHome()
}

/**
 * CCR and AgenC Desktop spawn the CLI with OAuth and should never fall back
 * to ambient plaintext API-key environment values. Without this guard, a user
 * who runs `agenc` in their terminal with an API key sees every CCD session
 * also use that key — and fail if it's stale/wrong-org.
 */
function isManagedOAuthContext(environment: ProviderEnvironment): boolean {
  return (
    isSessionRemoteMode() ||
    environment.AGENC_ENTRYPOINT === 'agenc-desktop'
  )
}

export function selectedProviderUsesExternalAuth(provider: string): boolean {
  return provider !== 'anthropic' && provider !== 'agenc'
}

export interface ProviderAuthReadContext {
  readonly home: HomeContext
  readonly environment: ProviderEnvironment
  readonly provider: string
}

/** Whether we are supporting direct 1P auth. */
// this code is closely related to getAuthTokenSource
export function isAnthropicAuthEnabled(): boolean {
  return isAnthropicAuthEnabledForContext({
    home: currentNativeHome(),
    environment: getSelectedProviderEnvironment(),
    provider: getSelectedProviderName(),
  })
}

export function isAnthropicAuthEnabledForContext(
  context: ProviderAuthReadContext,
): boolean {
  const { environment } = context
  // External providers never use Anthropic authentication, including through
  // the `agenc ssh` auth proxy below, so decide on provider identity before
  // inspecting any environment value or credential storage.
  if (selectedProviderUsesExternalAuth(context.provider)) return false

  // `agenc ssh` remote: ANTHROPIC_UNIX_SOCKET tunnels API calls through a
  // local auth-injecting proxy. The launcher sets AGENC_OAUTH_TOKEN as a
  // placeholder iff the local side is a subscriber (so the remote includes the
  // oauth-2025 beta header to match what the proxy will inject). The remote's
  // Ambient API-key environment values MUST NOT flip this — they would cause
  // a header mismatch with the proxy and a bogus
  // "invalid x-api-key" from the API. See utils/proxy.ts and
  // utils/managedEnv.ts.
  if (environment.ANTHROPIC_UNIX_SOCKET) {
    return !!environment.AGENC_OAUTH_TOKEN
  }

  // Check if user has configured an external API key source
  // This allows externally-provided API keys to work (without requiring proxy configuration)
  const hasExternalAuthToken =
    environment.ANTHROPIC_AUTH_TOKEN ||
    environment.AGENC_API_KEY_FILE_DESCRIPTOR

  // Check if API key is from an external source (not managed by /login).
  // Predicate must not throw: getAnthropicApiKeyWithSource throws under
  // CI/NODE_ENV=test when no key is configured, but here we just want to
  // know the source — "no key" is a valid answer.
  let apiKeySource: ApiKeySource
  try {
    ;({ source: apiKeySource } =
      getAnthropicApiKeyWithSourceForContext(context))
  } catch {
    apiKeySource = 'none'
  }
  const hasExternalApiKey =
    apiKeySource === 'ANTHROPIC_API_KEY'

  // Disable provider auth if:
  // 1. User has an external API key (regardless of proxy configuration)
  // 2. User has an external auth token (regardless of proxy configuration)
  // this may cause issues if users have complex proxy / gateway "client-side creds" auth scenarios,
  // e.g. if they want to set X-Api-Key to a gateway key but use provider OAuth for the Authorization
  // if we get reports of that, we should probably add an env var to force OAuth enablement
  const shouldDisableAuth =
    (hasExternalAuthToken && !isManagedOAuthContext(environment)) ||
    (hasExternalApiKey && !isManagedOAuthContext(environment))

  return !shouldDisableAuth
}

/** Where the auth token is being sourced from, if any. */
// this code is closely related to isAnthropicAuthEnabled
export function getAuthTokenSource(home: HomeContext) {
  return getAuthTokenSourceForContext({
    home,
    environment: getSelectedProviderEnvironment(),
    provider: getSelectedProviderName(),
  })
}

/** Resolve token provenance from one immutable provider/session authority. */
export function getAuthTokenSourceForContext(
  context: ProviderAuthReadContext,
) {
  const { environment, home } = context
  if (selectedProviderUsesExternalAuth(context.provider)) {
    return { source: 'none' as const, hasToken: false }
  }
  if (
    environment.ANTHROPIC_AUTH_TOKEN &&
    !isManagedOAuthContext(environment)
  ) {
    return { source: 'ANTHROPIC_AUTH_TOKEN' as const, hasToken: true }
  }

  if (environment.AGENC_OAUTH_TOKEN) {
    return { source: 'AGENC_OAUTH_TOKEN' as const, hasToken: true }
  }

  // Check for OAuth token from a transient descriptor or the native secure storage
  // continuity record used by remote subprocesses.
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor(home, environment)
  if (oauthTokenFromFd) {
    if (environment.AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR) {
      return {
        source: 'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR' as const,
        hasToken: true,
      }
    }
    return {
      source: 'native-secure-storage' as const,
      hasToken: true,
    }
  }

  const oauthTokens = getAgenCAIOAuthTokens(home, environment)
  if (shouldUseAgenCAIAuth(oauthTokens?.scopes) && oauthTokens?.accessToken) {
    return { source: 'agenc-cloud' as const, hasToken: true }
  }

  return { source: 'none' as const, hasToken: false }
}

export type ApiKeySource =
  | 'ANTHROPIC_API_KEY'
  | '/login managed key'
  | 'none'

export function getAnthropicApiKey(): null | string {
  const { key } = getAnthropicApiKeyWithSource()
  return key
}

export function hasAnthropicApiKeyAuth(): boolean {
  // Predicate: never throw. getAnthropicApiKeyWithSource throws under
  // CI/NODE_ENV=test when no key is configured — but "do we have auth?" is
  // exactly the question that has to answer cleanly in that state.
  try {
    const { key, source } = getAnthropicApiKeyWithSource()
    return key !== null && source !== 'none'
  } catch {
    return false
  }
}

export function getAnthropicApiKeyWithSource(): {
  key: null | string
  source: ApiKeySource
} {
  return getAnthropicApiKeyWithSourceForContext({
    home: currentNativeHome(),
    environment: getSelectedProviderEnvironment(),
    provider: getSelectedProviderName(),
  })
}

export function getAnthropicApiKeyWithSourceForContext(
  context: ProviderAuthReadContext,
): {
  key: null | string
  source: ApiKeySource
} {
  const { environment, home } = context
  if (selectedProviderUsesExternalAuth(context.provider)) {
    return { key: null, source: 'none' }
  }
  // On homespace, don't use ANTHROPIC_API_KEY (use Console key instead)
  // https://anthropic.slack.com/archives/C08428WSLKV/p1747331773214779
  const apiKeyEnv = isRunningOnHomespace(environment)
    ? undefined
    : environment.ANTHROPIC_API_KEY

  // Always check for direct environment variable when the user ran agenc --print.
  // This is useful for CI, etc.
  if (preferThirdPartyAuthentication() && apiKeyEnv) {
    return {
      key: apiKeyEnv,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  if (isEnvTruthy(process.env.CI) || process.env.NODE_ENV === 'test') {
    // Check for API key from file descriptor first
    const apiKeyFromFd = getApiKeyFromFileDescriptor(
      home,
      environment,
    )
    if (apiKeyFromFd) {
      return {
        key: apiKeyFromFd,
        source: 'ANTHROPIC_API_KEY',
      }
    }

    if (
      !apiKeyEnv &&
      !environment.AGENC_OAUTH_TOKEN &&
      !environment.AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR
    ) {
      throw new Error(
        'ANTHROPIC_API_KEY or AGENC_OAUTH_TOKEN env var is required',
      )
    }

    if (apiKeyEnv) {
      return {
        key: apiKeyEnv,
        source: 'ANTHROPIC_API_KEY',
      }
    }

    // OAuth token is present but this function returns API keys only
    // Also reached when 3P provider is active — ANTHROPIC_API_KEY is ignored
    return {
      key: null,
      source: 'none',
    }
  }
  // Check for ANTHROPIC_API_KEY before the securely stored managed key.
  if (
    apiKeyEnv &&
    readNativeSecureStorage(home).apiKeyApprovals?.approved?.includes(
      normalizeApiKeyForConfig(apiKeyEnv),
    )
  ) {
    return {
      key: apiKeyEnv,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  // Check for API key from file descriptor
  const apiKeyFromFd = getApiKeyFromFileDescriptor(
    home,
    environment,
  )
  if (apiKeyFromFd) {
    return {
      key: apiKeyFromFd,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  const securelyStoredApiKey = getPrimaryApiKeyFromSecureStorage(home)
  if (securelyStoredApiKey) {
    return securelyStoredApiKey
  }

  return {
    key: null,
    source: 'none',
  }
}

/** @private Use {@link getAnthropicApiKey} or {@link getAnthropicApiKeyWithSource} */
export function getPrimaryApiKeyFromSecureStorage(
  home: HomeContext,
): { key: string; source: ApiKeySource } | null {
  const key = readNativeSecureStorage(home).primaryApiKey?.trim()
  return key ? { key, source: '/login managed key' } : null
}

function isValidApiKey(apiKey: string): boolean {
  // Only allow alphanumeric characters, dashes, and underscores
  return /^[a-zA-Z0-9-_]+$/.test(apiKey)
}

export async function saveApiKey(apiKey: string): Promise<void> {
  if (!isValidApiKey(apiKey)) {
    throw new Error(
      'Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.',
    )
  }

  const normalizedKey = normalizeApiKeyForConfig(apiKey)
  updateNativeSecureStorage(
    currentNativeHome(),
    current => {
      const approved = current.apiKeyApprovals?.approved ?? []
      return {
        ...current,
        primaryApiKey: apiKey,
        apiKeyApprovals: {
          approved: approved.includes(normalizedKey)
            ? approved
            : [...approved, normalizedKey],
          rejected: current.apiKeyApprovals?.rejected ?? [],
        },
      }
    },
    'Native secure storage is unavailable; the API key was not saved.',
  )
}

export function isCustomApiKeyApproved(apiKey: string): boolean {
  const normalizedKey = normalizeApiKeyForConfig(apiKey)
  return (
    readNativeSecureStorage(currentNativeHome()).apiKeyApprovals?.approved?.includes(normalizedKey) ??
    false
  )
}

export async function removeApiKey(): Promise<void> {
  updateNativeSecureStorage(
    currentNativeHome(),
    current => {
      const next = { ...current }
      delete next.primaryApiKey
      return next
    },
    'Native secure storage is unavailable; the API key was not removed.',
  )
}

type StoredAgenCAIOauth = NonNullable<SecureStorageData['agencAiOauth']>

class AgenCAIOauthConflictError extends Error {
  readonly name = 'AgenCAIOauthConflictError'
}

function comparableAgenCAIOauth(value: OAuthTokens | StoredAgenCAIOauth | null | undefined) {
  if (!value?.accessToken) return undefined
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken ?? undefined,
    expiresAt: value.expiresAt ?? undefined,
    scopes: value.scopes ?? undefined,
    subscriptionType: value.subscriptionType ?? null,
    rateLimitTier: value.rateLimitTier ?? null,
  }
}

function sameAgenCAIOauth(
  left: OAuthTokens | StoredAgenCAIOauth | null | undefined,
  right: OAuthTokens | StoredAgenCAIOauth | null | undefined,
): boolean {
  return JSON.stringify(comparableAgenCAIOauth(left)) ===
    JSON.stringify(comparableAgenCAIOauth(right))
}

function writeAgenCAIOAuthTokens(
  home: HomeContext,
  tokens: OAuthTokens,
  expected?: OAuthTokens,
): void {
  updateNativeSecureStorage(
    home,
    current => {
      const existing = current.agencAiOauth
      if (expected !== undefined && !sameAgenCAIOauth(existing, expected)) {
        throw new AgenCAIOauthConflictError(
          'AgenC AI OAuth credentials changed while refresh was in flight',
        )
      }
      const next: StoredAgenCAIOauth = {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
        ...(tokens.scopes ? { scopes: tokens.scopes } : {}),
        subscriptionType:
          tokens.subscriptionType ?? existing?.subscriptionType ?? null,
        rateLimitTier:
          tokens.rateLimitTier ?? existing?.rateLimitTier ?? null,
      }
      return { ...current, agencAiOauth: next }
    },
    'Native secure storage is unavailable; AgenC AI OAuth credentials were not saved.',
  )
}

// Function to store OAuth tokens in secure storage
export function saveOAuthTokensIfNeeded(
  home: HomeContext,
  tokens: OAuthTokens,
): {
  success: boolean
  warning?: string
} {
  if (!shouldUseAgenCAIAuth(tokens.scopes)) {
    return { success: true }
  }

  // Skip saving inference-only tokens (they come from env vars)
  if (!tokens.refreshToken || !tokens.expiresAt) {
    return { success: true }
  }

  try {
    writeAgenCAIOAuthTokens(home, tokens)
    clearAgenCAIOAuthTokenCache(home)
    return { success: true }
  } catch (error) {
    logError(error)
    return { success: false, warning: 'Failed to save OAuth tokens' }
  }
}

const readPersistedAgenCAIOAuthTokens = memoize((home: HomeContext): OAuthTokens | null => {
  try {
    const storageData = readNativeSecureStorage(home)
    const oauthData = storageData?.agencAiOauth

    if (!oauthData?.accessToken) {
      return null
    }

    return oauthData
  } catch (error) {
    logError(error)
    return null
  }
}, secureStorageIdentityKey)

export function getAgenCAIOAuthTokens(
  home: HomeContext,
  environment: ProviderEnvironment,
): OAuthTokens | null {
  // Check for force-set OAuth token from environment variable
  if (environment.AGENC_OAUTH_TOKEN) {
    // Return an inference-only token (unknown refresh and expiry)
    return {
      accessToken: environment.AGENC_OAUTH_TOKEN,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  // Check for OAuth token from file descriptor
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor(home, environment)
  if (oauthTokenFromFd) {
    // Return an inference-only token (unknown refresh and expiry)
    return {
      accessToken: oauthTokenFromFd,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  return readPersistedAgenCAIOAuthTokens(home)
}

function clearAgenCAIOAuthTokenCache(home: HomeContext): void {
  readPersistedAgenCAIOAuthTokens.cache.delete?.(secureStorageIdentityKey(home))
}

/**
 * Clears all OAuth token caches. Call this on 401 errors to ensure
 * the next token read comes from secure storage, not stale in-memory caches.
 * This handles the case where the local expiration check disagrees with the
 * server (e.g., due to clock corrections after token was issued).
 */
export function clearOAuthTokenCache(home: HomeContext): void {
  clearAgenCAIOAuthTokenCache(home)
  clearKeychainCache()
}

// In-flight deduplication: when N AgenC cloud proxy connectors hit 401 with
// the same token simultaneously (common at startup, #20930), only one should
// clear caches and reread native secure storage. Otherwise, each call to
// clearOAuthTokenCache() invalidates readInFlight in macOsKeychainStorage and
// starts another synchronous child process. Stacked child processes blocked
// rendering for more than 800ms.
const pending401Handlers = new Map<string, Promise<boolean>>()

/**
 * Handle a 401 "OAuth token has expired" error from the API.
 *
 * This function forces a token refresh when the server says the token is expired,
 * even if our local expiration check disagrees (which can happen due to clock
 * issues when the token was issued).
 *
 * Safety: We compare the failed token with native secure storage. If another
 * process already refreshed and stored a different token, we use that instead of
 * refreshing again. Concurrent calls with the same failedAccessToken are
 * deduplicated to a single native secure storage read.
 *
 * @param failedAccessToken - The access token that was rejected with 401
 * @returns true if we now have a valid token, false otherwise
 */
export function handleOAuth401Error(
  home: HomeContext,
  failedAccessToken: string,
  environment: ProviderEnvironment,
): Promise<boolean> {
  const key = `${secureStorageIdentityKey(home)}\0${oauthEnvironmentIdentity(environment)}\0${failedAccessToken}`
  const pending = pending401Handlers.get(key)
  if (pending) return pending

  const promise = handleOAuth401ErrorImpl(
    home,
    failedAccessToken,
    environment,
  ).finally(() => {
    pending401Handlers.delete(key)
  })
  pending401Handlers.set(key, promise)
  return promise
}

async function handleOAuth401ErrorImpl(
  home: HomeContext,
  failedAccessToken: string,
  environment: ProviderEnvironment,
): Promise<boolean> {
  // Clear caches and reread native secure storage asynchronously. A synchronous
  // read blocks for about 100ms per call.
  clearOAuthTokenCache(home)
  const currentTokens = await getAgenCAIOAuthTokensAsync(home, environment)

  if (!currentTokens?.refreshToken) {
    return false
  }

  // If native secure storage has a different token, another process refreshed it.
  if (currentTokens.accessToken !== failedAccessToken) {
    return true
  }

  // Same token that failed - force refresh, bypassing local expiration check
  return checkAndRefreshOAuthTokenIfNeeded(home, environment, 0, true)
}

/**
 * Reads OAuth tokens asynchronously, avoiding blocking native storage reads.
 * Delegates to the sync memoized version for env var / file descriptor tokens
 * (which do not read native secure storage), and only uses async for storage reads.
 */
export async function getAgenCAIOAuthTokensAsync(
  home: HomeContext,
  environment: ProviderEnvironment,
): Promise<OAuthTokens | null> {
  // Env var and file-descriptor tokens are synchronous and do not read native
  // secure storage.
  if (
    environment.AGENC_OAUTH_TOKEN ||
    getOAuthTokenFromFileDescriptor(home, environment)
  ) {
    return getAgenCAIOAuthTokens(home, environment)
  }

  try {
    const storageData = await readNativeSecureStorageAsync(home)
    const oauthData = storageData?.agencAiOauth
    if (!oauthData?.accessToken) {
      return null
    }
    return oauthData
  } catch (error) {
    logError(error)
    return null
  }
}

// In-flight promise for deduplicating concurrent calls, isolated per home and
// immutable session environment. Sessions that share a home may still carry
// different transient OAuth/descriptor inputs.
const pendingRefreshChecks = new Map<string, Promise<boolean>>()

const oauthEnvironmentIdentities = new WeakMap<object, number>()
let nextOAuthEnvironmentIdentity = 1

function oauthEnvironmentIdentity(environment: ProviderEnvironment): number {
  const existing = oauthEnvironmentIdentities.get(environment)
  if (existing !== undefined) return existing
  const identity = nextOAuthEnvironmentIdentity
  nextOAuthEnvironmentIdentity += 1
  oauthEnvironmentIdentities.set(environment, identity)
  return identity
}

export function checkAndRefreshOAuthTokenIfNeeded(
  home: HomeContext,
  environment: ProviderEnvironment,
  retryCount = 0,
  force = false,
): Promise<boolean> {
  const key = `${secureStorageIdentityKey(home)}\0${oauthEnvironmentIdentity(environment)}`
  // Deduplicate concurrent non-retry, non-force calls
  if (retryCount === 0 && !force) {
    const existing = pendingRefreshChecks.get(key)
    if (existing) {
      return existing
    }

    const promise = checkAndRefreshOAuthTokenIfNeededImpl(
      home,
      environment,
      retryCount,
      force,
    )
    const pending = promise.finally(() => {
      if (pendingRefreshChecks.get(key) === pending) {
        pendingRefreshChecks.delete(key)
      }
    })
    pendingRefreshChecks.set(key, pending)
    return pending
  }

  return checkAndRefreshOAuthTokenIfNeededImpl(
    home,
    environment,
    retryCount,
    force,
  )
}

async function checkAndRefreshOAuthTokenIfNeededImpl(
  home: HomeContext,
  environment: ProviderEnvironment,
  retryCount: number,
  force: boolean,
): Promise<boolean> {
  const MAX_RETRIES = 5


  // First check if token is expired with cached value
  // Skip this check if force=true (server already told us token is bad)
  const tokens = getAgenCAIOAuthTokens(home, environment)
  if (!force) {
    if (!tokens?.refreshToken || !isOAuthTokenExpired(tokens.expiresAt)) {
      return false
    }
  }

  if (!tokens?.refreshToken) {
    return false
  }

  if (!shouldUseAgenCAIAuth(tokens.scopes)) {
    return false
  }

  // Re-read tokens async to check if they're still expired
  // Another process might have refreshed them
  clearAgenCAIOAuthTokenCache(home)
  clearKeychainCache()
  const freshTokens = await getAgenCAIOAuthTokensAsync(home, environment)
  if (
    !freshTokens?.refreshToken ||
    !isOAuthTokenExpired(freshTokens.expiresAt)
  ) {
    return false
  }

  // Tokens are still expired, try to acquire lock and refresh
  await mkdir(home.path, { recursive: true })

  let release
  try {
    release = await lockfile.lock(join(home.path, '.agenc-ai-oauth-refresh'), {
      realpath: false,
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'ELOCKED') {
      // Another process has the lock, let's retry if we haven't exceeded max retries
      if (retryCount < MAX_RETRIES) {
        // Wait a bit before retrying
        await sleep(1000 + Math.random() * 1000)
        return checkAndRefreshOAuthTokenIfNeededImpl(
          home,
          environment,
          retryCount + 1,
          force,
        )
      }
      return false
    }
    logError(err)
    return false
  }
  try {
    // Check one more time after acquiring lock
    clearAgenCAIOAuthTokenCache(home)
    clearKeychainCache()
    const lockedTokens = await getAgenCAIOAuthTokensAsync(home, environment)
    if (
      !lockedTokens?.refreshToken ||
      !isOAuthTokenExpired(lockedTokens.expiresAt)
    ) {
      return false
    }

    const refreshedTokens = await refreshOAuthToken(lockedTokens.refreshToken, {
      // For AgenC.ai subscribers, omit scopes so the default
      // AGENC_AI_OAUTH_SCOPES applies — this allows scope expansion
      // (e.g. adding user:file_upload) on refresh without re-login.
      scopes: shouldUseAgenCAIAuth(lockedTokens.scopes)
        ? undefined
        : lockedTokens.scopes,
    })
    try {
      writeAgenCAIOAuthTokens(home, refreshedTokens, lockedTokens)
    } catch (error) {
      if (error instanceof AgenCAIOauthConflictError) {
        clearAgenCAIOAuthTokenCache(home)
        const adopted = await getAgenCAIOAuthTokensAsync(home, environment)
        return Boolean(adopted && adopted.accessToken !== lockedTokens.accessToken)
      }
      throw error
    }

    // Clear the cache after refreshing token
    clearAgenCAIOAuthTokenCache(home)
    clearKeychainCache()
    return true
  } catch (error) {
    logError(error)

    clearAgenCAIOAuthTokenCache(home)
    clearKeychainCache()
    const currentTokens = await getAgenCAIOAuthTokensAsync(home, environment)
    if (currentTokens && !isOAuthTokenExpired(currentTokens.expiresAt)) {
      return true
    }

    return false
  } finally {
    await release()
  }
}

export function isAgenCAISubscriber(home: HomeContext): boolean {
  return isAgenCAISubscriberForContext({
    home,
    environment: getSelectedProviderEnvironment(),
    provider: getSelectedProviderName(),
  })
}

export function isAgenCAISubscriberForContext(
  context: ProviderAuthReadContext,
): boolean {
  if (!isAnthropicAuthEnabledForContext(context)) {
    return false
  }

  return shouldUseAgenCAIAuth(
    getAgenCAIOAuthTokens(context.home, context.environment)?.scopes,
  )
}

/**
 * Check if the current OAuth token has the user:profile scope.
 *
 * Real /login tokens always include this scope. Env-var and file-descriptor
 * tokens (service keys) hardcode scopes to ['user:inference'] only. Use this
 * to gate calls to profile-scoped endpoints so service key sessions don't
 * generate 403 storms against /api/oauth/profile, bootstrap, etc.
 */
export function hasProfileScope(
  home: HomeContext,
  environment: ProviderEnvironment,
): boolean {
  return (
    getAgenCAIOAuthTokens(home, environment)?.scopes?.includes(
      AGENC_AI_PROFILE_SCOPE,
    ) ?? false
  )
}

export function is1PApiCustomer(home: HomeContext): boolean {
  // 1P API customers are users who are NOT:
  // 1. AgenC.ai subscribers (Max, Pro, Enterprise, Team)
  // 2. Vertex AI users
  // 3. AWS Bedrock users
  // 4. Foundry users

  // Exclude cloud-adapter customers. Vertex and Foundry are rejected at
  // canonical config ingress, but keep the classification fail-closed for
  // callers that inspect an unvalidated embedding environment.
  const selectedProvider = getSelectedProviderName()
  if (
    selectedProvider === 'amazon-bedrock' ||
    selectedProvider === 'vertex' ||
    selectedProvider === 'foundry'
  ) {
    return false
  }

  // Exclude AgenC.ai subscribers
  if (isAgenCAISubscriber(home)) {
    return false
  }

  // Everyone else is an API customer (OAuth API customers, direct API key users, etc.)
  return true
}

/**
 * Gets OAuth account information when provider auth is enabled.
 * Returns undefined when using external API keys or third-party services.
 */
export function getOauthAccountInfo(
  home: HomeContext,
): OAuthAccountMetadata | undefined {
  return isAnthropicAuthEnabled()
    ? readNativeSecureStorage(home).oauthAccountMetadata
    : undefined
}

/**
 * Checks if overage/extra usage provisioning is allowed for this organization.
 * This mirrors the logic in apps/agenc-ai `useIsOverageProvisioningAllowed` hook as closely as possible.
 */
export function isOverageProvisioningAllowed(home: HomeContext): boolean {
  const accountInfo = getOauthAccountInfo(home)
  const billingType = accountInfo?.billingType

  // Must be a AgenC subscriber with a supported subscription type
  if (!isAgenCAISubscriber(home) || !billingType) {
    return false
  }

  // only allow Stripe and mobile billing types to purchase extra usage
  if (
    billingType !== 'stripe_subscription' &&
    billingType !== 'stripe_subscription_contracted' &&
    billingType !== 'apple_subscription' &&
    billingType !== 'google_play_subscription'
  ) {
    return false
  }

  return true
}

// Returns whether the user has Opus access at all, regardless of whether they
// are a subscriber or PayG.
export function hasOpusAccess(home: HomeContext): boolean {
  const subscriptionType = getSubscriptionType(home)

  return (
    subscriptionType === 'max' ||
    subscriptionType === 'enterprise' ||
    subscriptionType === 'team' ||
    subscriptionType === 'pro' ||
    // subscriptionType === null covers both API users and the case where
    // subscribers do not have subscription type populated. For those
    // subscribers, when in doubt, we should not limit their access to Opus.
    subscriptionType === null
  )
}

export function getSubscriptionType(home: HomeContext): SubscriptionType | null {
  return getSubscriptionTypeForContext({
    home,
    environment: getSelectedProviderEnvironment(),
    provider: getSelectedProviderName(),
  })
}

export function getSubscriptionTypeForContext(
  context: ProviderAuthReadContext,
): SubscriptionType | null {
  if (!isAnthropicAuthEnabledForContext(context)) {
    return null
  }
  const oauthTokens = getAgenCAIOAuthTokens(
    context.home,
    context.environment,
  )
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.subscriptionType ?? null
}

export function isMaxSubscriber(home: HomeContext): boolean {
  return getSubscriptionType(home) === 'max'
}

export function isTeamSubscriber(home: HomeContext): boolean {
  return getSubscriptionType(home) === 'team'
}

export function isTeamPremiumSubscriber(home: HomeContext): boolean {
  return (
    getSubscriptionType(home) === 'team' &&
    getRateLimitTier(home) === 'default_claude_max_5x'
  )
}

export function isEnterpriseSubscriber(home: HomeContext): boolean {
  return getSubscriptionType(home) === 'enterprise'
}

export function isProSubscriber(home: HomeContext): boolean {
  return getSubscriptionType(home) === 'pro'
}

export function getRateLimitTier(home: HomeContext): string | null {
  if (!isAnthropicAuthEnabled()) {
    return null
  }
  const oauthTokens = getAgenCAIOAuthTokens(
    home,
    getSelectedProviderEnvironment(),
  )
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.rateLimitTier ?? null
}

export function getSubscriptionName(home: HomeContext): string {
  const subscriptionType = getSubscriptionType(home)

  switch (subscriptionType) {
    case 'enterprise':
      return 'AgenC Enterprise'
    case 'team':
      return 'AgenC Team'
    case 'max':
      return 'AgenC Max'
    case 'pro':
      return 'AgenC Pro'
    default:
      return 'AgenC API'
  }
}

/** Check whether the selected provider uses external provider authentication. */
export function isUsing3PServices(): boolean {
  return selectedProviderUsesExternalAuth(getSelectedProviderName())
}

function isConsumerPlan(plan: SubscriptionType): plan is 'max' | 'pro' {
  return plan === 'max' || plan === 'pro'
}

export function isConsumerSubscriber(home: HomeContext): boolean {
  const subscriptionType = getSubscriptionType(home)
  return (
    isAgenCAISubscriber(home) &&
    subscriptionType !== null &&
    isConsumerPlan(subscriptionType)
  )
}

export type UserAccountInfo = {
  subscription?: string
  tokenSource?: string
  apiKeySource?: ApiKeySource
  organization?: string
  email?: string
}

export function getAccountInformation(home: HomeContext) {
  const apiProvider = getAPIProvider()
  // Only provide account info for first-party provider API
  if (apiProvider !== 'firstParty') {
    return undefined
  }
  const { source: authTokenSource } = getAuthTokenSource(home)
  const accountInfo: UserAccountInfo = {}
  if (
    authTokenSource === 'AGENC_OAUTH_TOKEN' ||
    authTokenSource === 'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR'
  ) {
    accountInfo.tokenSource = authTokenSource
  } else if (isAgenCAISubscriber(home)) {
    accountInfo.subscription = getSubscriptionName(home)
  } else {
    accountInfo.tokenSource = authTokenSource
  }
  const { key: apiKey, source: apiKeySource } = getAnthropicApiKeyWithSource()
  if (apiKey) {
    accountInfo.apiKeySource = apiKeySource
  }

  // We don't know the organization if we're relying on an external API key or auth token
  if (
    authTokenSource === 'agenc-cloud' ||
    apiKeySource === '/login managed key'
  ) {
    // Get organization name from OAuth account info
    const orgName = getOauthAccountInfo(home)?.organizationName
    if (orgName) {
      accountInfo.organization = orgName
    }
  }
  const email = getOauthAccountInfo(home)?.emailAddress
  if (
    (authTokenSource === 'agenc-cloud' ||
      apiKeySource === '/login managed key') &&
    email
  ) {
    accountInfo.email = email
  }
  return accountInfo
}

/**
 * Result of org validation — either success or a descriptive error.
 */
export type OrgValidationResult =
  | { valid: true }
  | { valid: false; message: string }

/**
 * Validate that the active OAuth token belongs to the organization required
 * by `forceLoginOrgUUID` in managed settings. Returns a result object
 * rather than throwing so callers can choose how to surface the error.
 *
 * Fails closed: if `forceLoginOrgUUID` is set and we cannot determine the
 * token's org (network error, missing profile data), validation fails.
 */
export async function validateForceLoginOrg(
  home: HomeContext,
): Promise<OrgValidationResult> {
  const environment = getSelectedProviderEnvironment()
  // `agenc ssh` remote: real auth lives on the local machine and is injected
  // by the proxy. The placeholder token can't be validated against the profile
  // endpoint. The local side already ran this check before establishing the session.
  if (environment.ANTHROPIC_UNIX_SOCKET) {
    return { valid: true }
  }

  if (!isAnthropicAuthEnabled()) {
    return { valid: true }
  }

  const requiredOrgUuid =
    getSettingsForSource('policySettings')?.forceLoginOrgUUID
  if (!requiredOrgUuid) {
    return { valid: true }
  }

  // Ensure the access token is fresh before hitting the profile endpoint.
  // No-op for env-var tokens (refreshToken is null).
  await checkAndRefreshOAuthTokenIfNeeded(home, environment)

  const tokens = getAgenCAIOAuthTokens(home, environment)
  if (!tokens) {
    return { valid: true }
  }

  // Always fetch the authoritative org UUID from the profile endpoint.
  // Even native-storage-sourced tokens verify server-side: the cached org UUID
  // in local runtime state is user-writable and cannot be trusted.
  const { source } = getAuthTokenSource(home)
  const isEnvVarToken =
    source === 'AGENC_OAUTH_TOKEN' ||
    source === 'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR'

  const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
  if (!profile) {
    // Fail closed — we can't verify the org
    return {
      valid: false,
      message:
        `Unable to verify organization for the current authentication token.\n` +
        `This machine requires organization ${requiredOrgUuid} but the profile could not be fetched.\n` +
        `This may be a network error, or the token may lack the user:profile scope required for\n` +
        `verification (tokens from 'agenc setup-token' do not include this scope).\n` +
        `Try again, or obtain a full-scope token via 'agenc auth login'.`,
    }
  }

  const tokenOrgUuid = profile.organization.uuid
  if (tokenOrgUuid === requiredOrgUuid) {
    return { valid: true }
  }

  if (isEnvVarToken) {
    const envVarName =
      source === 'AGENC_OAUTH_TOKEN'
        ? 'AGENC_OAUTH_TOKEN'
        : 'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR'
    return {
      valid: false,
      message:
        `The ${envVarName} environment variable provides a token for a\n` +
        `different organization than required by this machine's managed settings.\n\n` +
        `Required organization: ${requiredOrgUuid}\n` +
        `Token organization:   ${tokenOrgUuid}\n\n` +
        `Remove the environment variable or obtain a token for the correct organization.`,
    }
  }

  return {
    valid: false,
    message:
      `Your authentication token belongs to organization ${tokenOrgUuid},\n` +
      `but this machine requires organization ${requiredOrgUuid}.\n\n` +
      `Please log in with the correct organization: agenc auth login`,
  }
}

export const getproviderApiKey = getAnthropicApiKey
export const getproviderApiKeyWithSource = getAnthropicApiKeyWithSource
export const isproviderAuthEnabled = isAnthropicAuthEnabled
// /login imports hasproviderApiKeyAuth — alias the underlying check.
export const hasproviderApiKeyAuth = hasAnthropicApiKeyAuth
