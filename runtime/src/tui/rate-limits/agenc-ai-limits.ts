import { useEffect, useState } from 'react'
import {
  currentLimits,
  getRawUtilization as getUpstreamRawUtilization,
  statusListeners,
} from 'src/services/claudeAiLimits.js' // branding-scan: allow existing upstream rate-limit service path
import type { AgenCAILimits as UpstreamAgenCAILimits } from 'src/services/claudeAiLimits.js' // branding-scan: allow existing upstream rate-limit service path

type RateLimitSnapshot = UpstreamAgenCAILimits
type RawUtilization = ReturnType<typeof getUpstreamRawUtilization>
type RateLimitService = {
  currentLimits: RateLimitSnapshot
  statusListeners: Set<(limits: RateLimitSnapshot) => void>
  getRawUtilization(): RawUtilization
}

const rateLimitService: RateLimitService = {
  get currentLimits() {
    return currentLimits
  },
  statusListeners,
  getRawUtilization: getUpstreamRawUtilization,
}
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
