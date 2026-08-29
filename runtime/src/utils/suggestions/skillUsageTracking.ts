import type { GlobalRuntimeState } from '../../config/runtime-state-repository.js'

/**
 * Calculates a usage score for a skill based on frequency and recency.
 * Higher scores indicate more frequently and recently used skills.
 *
 * The score uses exponential decay with a half-life of 7 days,
 * meaning usage from 7 days ago is worth half as much as usage today.
 */
export function getSkillUsageScore(
  skillName: string,
  runtimeState: Pick<GlobalRuntimeState, 'skillUsage'>,
): number {
  const usage = runtimeState.skillUsage?.[skillName]
  if (!usage) return 0

  // Recency decay: halve score every 7 days
  const daysSinceUse = (Date.now() - usage.lastUsedAt) / (1000 * 60 * 60 * 24)
  const recencyFactor = Math.pow(0.5, daysSinceUse / 7)

  // Minimum recency factor of 0.1 to avoid completely dropping old but heavily used skills
  return usage.usageCount * Math.max(recencyFactor, 0.1)
}
