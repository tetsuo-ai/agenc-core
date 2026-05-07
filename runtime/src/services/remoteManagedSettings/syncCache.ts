// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
/**
 * Eligibility check for remote managed settings.
 *
 * The cache state itself lives in syncCacheState.ts (a leaf, no auth import).
 * This file keeps isRemoteManagedSettingsEligible — the one function that
 * needs auth.ts — plus resetSyncCache wrapped to clear the local eligibility
 * mirror alongside the leaf's state.
 */

import { AGENC_AI_INFERENCE_SCOPE } from '../../constants/oauth.js'
import {
  getproviderApiKeyWithSource,
  getAgenCAIOAuthTokens,
} from '../../utils/auth.js'
import {
  getAPIProvider,
  isFirstPartyproviderBaseUrl,
} from '../../utils/model/providers.js'

import {
  resetSyncCache as resetLeafCache,
  setEligibility,
} from './syncCacheState.js'

let cached: boolean | undefined

export function resetSyncCache(): void {
  cached = undefined
  resetLeafCache()
}

/**
 * Check if the current user is eligible for remote managed settings
 *
 * Eligibility:
 * - Console users (API key): All eligible (must have actual key, not just apiKeyHelper)
 * - OAuth users with known subscriptionType: Only Enterprise/C4E and Team
 * - OAuth users with subscriptionType === null (externally-injected tokens via
 *   AGENC_OAUTH_TOKEN / FD, or keychain tokens missing metadata): Eligible —
 *   the API returns empty settings for ineligible orgs, so the cost of a false
 *   positive is one round-trip
 *
 * This is a pre-check to determine if we should query the API.
 * The API will return empty settings for users without managed settings.
 *
 * IMPORTANT: This function must NOT call getSettings() or any function that calls
 * getSettings() to avoid circular dependencies during settings loading.
 */
export function isRemoteManagedSettingsEligible(): boolean {
  if (cached !== undefined) return cached

  // 3p provider users should not hit the settings endpoint
  if (getAPIProvider() !== 'firstParty') {
    return (cached = setEligibility(false))
  }

  // Custom base URL users should not hit the settings endpoint
  if (!isFirstPartyproviderBaseUrl()) {
    return (cached = setEligibility(false))
  }

  // Cowork runs in a VM with its own permission model; server-managed settings
  // (designed for CLI/CCD) don't apply there, and per-surface settings don't
  // exist yet. MDM/file-based managed settings still apply via settings.ts —
  // those require physical deployment and a different IT intent.
  if (process.env.AGENC_ENTRYPOINT === 'local-agent') {
    return (cached = setEligibility(false))
  }

  // Check OAuth first: most AgenC.ai users have no API key in the keychain.
  // The API key check spawns `security find-generic-password` (~20-50ms) which
  // returns null for OAuth-only users. Checking OAuth first short-circuits
  // that subprocess for the common case.
  const tokens = getAgenCAIOAuthTokens()

  // Externally-injected tokens (CCD via AGENC_OAUTH_TOKEN, CCR via
  // AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR, Agent SDK, CI) carry no
  // subscriptionType metadata — getAgenCAIOAuthTokens() constructs them with
  // subscriptionType: null. The token itself is valid; let the API decide.
  // fetchRemoteManagedSettings handles 204/404 gracefully (returns {}), and
  // settings.ts falls through to MDM/file when remote is empty, so ineligible
  // orgs pay one round-trip and nothing else changes.
  if (tokens?.accessToken && tokens.subscriptionType === null) {
    return (cached = setEligibility(true))
  }

  if (
    tokens?.accessToken &&
    tokens.scopes?.includes(AGENC_AI_INFERENCE_SCOPE) &&
    (tokens.subscriptionType === 'enterprise' ||
      tokens.subscriptionType === 'team')
  ) {
    return (cached = setEligibility(true))
  }

  // Console users (API key) are eligible if we can get the actual key
  // Skip apiKeyHelper to avoid circular dependency with getSettings()
  // Wrap in try-catch because getproviderApiKeyWithSource throws in CI/test environments
  // when no API key is available
  try {
    const { key: apiKey } = getproviderApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (apiKey) {
      return (cached = setEligibility(true))
    }
  } catch {
    // No API key available (e.g., CI/test environment)
  }

  return (cached = setEligibility(false))
}
