import { getRateLimitTier, getSubscriptionType } from './auth.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { resolveSecureStorageHome } from './secureStorage/home.js'

function credentialHome() {
  return resolveSecureStorageHome()
}

export function getPlanModeV2AgentCount(): number {
  // Environment variable override takes precedence
  if (process.env.AGENC_PLAN_V2_AGENT_COUNT) {
    const count = parseInt(process.env.AGENC_PLAN_V2_AGENT_COUNT, 10)
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
  }

  const subscriptionType = getSubscriptionType(credentialHome())
  const rateLimitTier = getRateLimitTier(credentialHome())

  if (
    subscriptionType === 'max' &&
    rateLimitTier === 'default_claude_max_20x'
  ) {
    return 3
  }

  if (subscriptionType === 'enterprise' || subscriptionType === 'team') {
    return 3
  }

  return 1
}

export function getPlanModeV2ExploreAgentCount(): number {
  if (process.env.AGENC_PLAN_V2_EXPLORE_AGENT_COUNT) {
    const count = parseInt(
      process.env.AGENC_PLAN_V2_EXPLORE_AGENT_COUNT,
      10,
    )
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
  }

  return 3
}

/**
 * Check if plan mode interview phase is enabled.
 *
 * Config: AGENC_PLAN_MODE_INTERVIEW_PHASE env var
 */
export function isPlanModeInterviewPhaseEnabled(): boolean {
  const env = process.env.AGENC_PLAN_MODE_INTERVIEW_PHASE
  if (isEnvTruthy(env)) return true
  if (isEnvDefinedFalsy(env)) return false

  return false
}

export type PewterLedgerVariant = 'trim' | 'cut' | 'cap' | null

/**
 * Plan file structure variant. Controls the Phase 4 "Final Plan" bullets in
 * the 5-phase plan mode workflow (messages.ts getPlanPhase4Section).
 *
 * Variants: null (default), 'trim', 'cut', 'cap' — progressively stricter
 * guidance on plan file size. Nothing selects a variant today.
 */
export function getPewterLedgerVariant(): PewterLedgerVariant {
  const raw: string | null = null
  if (raw === 'trim' || raw === 'cut' || raw === 'cap') return raw
  return null
}
