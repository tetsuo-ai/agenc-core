/** Lightweight service-name and cache helpers for macOS secure storage. */

import { createHash } from 'crypto'
import { userInfo } from 'os'
import type { HomeContext } from '../../config/home.js'
import type { SecureStorageData } from './index.js'

// Suffix identifying the canonical credentials entry in the macOS Keychain.
// Do not change this value. It is part of the macOS Keychain lookup key and would
// orphan existing stored credentials.
export const CREDENTIALS_SERVICE_SUFFIX = '-credentials'

/**
 * Format the native secure storage service name. A scoped path is hashed; omitting it
 * preserves the original default namespace. Migration code uses this same
 * formatter to locate the retired config-directory-derived identity without
 * giving that variable any ordinary runtime authority.
 */
function formatSecureStorageServiceName(
  serviceSuffix: string,
  scopedPath: string | undefined,
  oauthFileSuffix: string,
  hashLength: number,
): string {
  const dirHash = scopedPath === undefined
    ? ''
    : `-${createHash('sha256').update(scopedPath).digest('hex').slice(0, hashLength)}`
  return `AgenC${oauthFileSuffix}${serviceSuffix}${dirHash}`
}

/** Reconstruct the historical 32-bit directory hash during explicit migration. */
export function formatRetiredSecureStorageServiceName(
  serviceSuffix: string,
  scopedPath: string | undefined,
  oauthFileSuffix: string,
): string {
  return formatSecureStorageServiceName(
    serviceSuffix,
    scopedPath,
    oauthFileSuffix,
    8,
  )
}

/**
 * Get the service/resource name for secure storage, scoped by canonical
 * AGENC_HOME when it selects a non-default location.
 */
export function getSecureStorageServiceName(
  home: HomeContext,
  serviceSuffix: string,
): string {
  // Use a hash of the canonical home path to create a unique but stable suffix.
  // Only add a suffix for non-default homes. An explicitly configured
  // default path has the same native secure storage identity as the implicit default.
  return formatSecureStorageServiceName(
    serviceSuffix,
    home.isDefault ? undefined : home.identityKey,
    home.oauthFileSuffix,
    32,
  )
}

export function getMacOsKeychainStorageServiceName(
  home: HomeContext,
  serviceSuffix: string,
): string {
  return getSecureStorageServiceName(home, serviceSuffix)
}

export function getUsername(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  try {
    return environment.USER || userInfo().username
  } catch {
    return 'agenc-code-user'
  }
}

// --

// Cache for macOS Keychain reads to avoid repeated expensive security CLI calls.
// TTL bounds staleness for cross-process scenarios (another AgenC instance
// refreshing/invalidating tokens) without forcing a blocking spawnSync on
// every read. In-process writes invalidate via clearKeychainCache() directly.
//
// The sync read() path takes ~500ms per `security` spawn. With 50+ AgenC cloud
// MCP connectors authenticating at startup, a short TTL expires mid-storm and
// triggers repeat sync reads — observed as a 5.5s event-loop stall
// (go/ccshare/adamj-20260326-212235). 30s of cross-process staleness is fine:
// OAuth tokens expire in hours, and the only cross-process writer is another
// AgenC instance's /login or refresh.
//
// Wrapped in an object so storage reads and writes share invalidation state.
export const KEYCHAIN_CACHE_TTL_MS = 30_000

export interface KeychainCacheState {
  cache: { data: SecureStorageData | null; cachedAt: number } // cachedAt 0 = invalid
  // Incremented on every cache invalidation. readAsync() captures this before
  // spawning and skips its cache write if a newer generation exists, preventing
  // a stale subprocess result from overwriting fresh data written by update().
  generation: number
  // Deduplicates concurrent readAsync() calls so TTL expiry under load spawns
  // one subprocess, not N. Cleared on invalidation so fresh reads don't join
  // a stale in-flight promise.
  readInFlight: Promise<SecureStorageData | null> | null
}

const keychainCacheStates = new Map<string, KeychainCacheState>()

/**
 * Return the cache owned by one concrete macOS Keychain entry. The service/account
 * identity is captured when the storage adapter is constructed, so changing
 * ambient environment variables cannot redirect a read or share cached bytes
 * with another AgenC home.
 */
export function getKeychainCacheState(
  serviceName: string,
  username: string,
): KeychainCacheState {
  const identity = `${serviceName}\0${username}`
  const existing = keychainCacheStates.get(identity)
  if (existing) return existing
  const created: KeychainCacheState = {
    cache: { data: null, cachedAt: 0 },
    generation: 0,
    readInFlight: null,
  }
  keychainCacheStates.set(identity, created)
  return created
}

export function clearKeychainCacheState(state: KeychainCacheState): void {
  state.cache = { data: null, cachedAt: 0 }
  state.generation++
  state.readInFlight = null
}

/** Clear every bound macOS Keychain cache after a global authentication reset. */
export function clearKeychainCache(): void {
  for (const state of keychainCacheStates.values()) {
    clearKeychainCacheState(state)
  }
}
