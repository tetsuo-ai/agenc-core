import { useEffect, useState } from 'react'

type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected'
type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'overage'
type RateLimitSnapshot = {
  status: QuotaStatus
  unifiedRateLimitFallbackAvailable: boolean
  resetsAt?: number
  rateLimitType?: RateLimitType
  utilization?: number
  overageStatus?: QuotaStatus
  overageResetsAt?: number
  overageDisabledReason?: string
  isUsingOverage?: boolean
  surpassedThreshold?: number
}
type RawWindowUtilization = {
  utilization: number
  resets_at: number
}
type RawUtilization = {
  five_hour?: RawWindowUtilization
  seven_day?: RawWindowUtilization
}
type RateLimitService = {
  currentLimits: RateLimitSnapshot
  statusListeners: Set<(limits: RateLimitSnapshot) => void>
  getRawUtilization(): RawUtilization
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rateLimitService = require('../../agenc/upstream/services/claudeAiLimits.js') as RateLimitService // branding-scan: allow existing upstream rate-limit service path
type AgenCAILimits = RateLimitSnapshot

export function useAgenCAiLimits(): AgenCAILimits {
  const [limits, setLimits] = useState<AgenCAILimits>({ ...rateLimitService.currentLimits })

  useEffect(() => {
    const listener = (newLimits: AgenCAILimits) => {
      setLimits({ ...newLimits })
    }
    rateLimitService.statusListeners.add(listener)

    return () => {
      rateLimitService.statusListeners.delete(listener)
    }
  }, [])

  return limits
}

export function getRawUtilization(): RawUtilization {
  const raw = rateLimitService.getRawUtilization()
  return {
    ...(raw.five_hour ? { five_hour: { ...raw.five_hour } } : {}),
    ...(raw.seven_day ? { seven_day: { ...raw.seven_day } } : {}),
  }
}
