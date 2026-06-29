/**
 * Privacy level controls how much nonessential network traffic AgenC generates.
 *
 * Levels are ordered by restrictiveness:
 *   default < essential-traffic
 *
 * - default:            Everything enabled.
 * - essential-traffic:  ALL nonessential network traffic disabled
 *                       (auto-updates, release notes, model capabilities, etc.).
 *
 * The resolved level is the most restrictive signal from:
 *   AGENC_DISABLE_NONESSENTIAL_TRAFFIC  →  essential-traffic
 */

type PrivacyLevel = 'default' | 'essential-traffic'

export function getPrivacyLevel(): PrivacyLevel {
  if (process.env.AGENC_DISABLE_NONESSENTIAL_TRAFFIC) {
    return 'essential-traffic'
  }
  return 'default'
}

/**
 * True when all nonessential network traffic should be suppressed.
 * Equivalent to the old `process.env.AGENC_DISABLE_NONESSENTIAL_TRAFFIC` check.
 */
export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

/**
 * Returns the env var name responsible for the current essential-traffic restriction,
 * or null if unrestricted. Used for user-facing "unset X to re-enable" messages.
 */
export function getEssentialTrafficOnlyReason(): string | null {
  if (process.env.AGENC_DISABLE_NONESSENTIAL_TRAFFIC) {
    return 'AGENC_DISABLE_NONESSENTIAL_TRAFFIC'
  }
  return null
}
