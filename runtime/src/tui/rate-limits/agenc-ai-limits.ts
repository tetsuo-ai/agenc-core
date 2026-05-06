import { useEffect, useState } from 'react'
import * as rateLimitService from '../../agenc/upstream/services/claudeAiLimits.js' // branding-scan: allow existing upstream rate-limit service path

type RawUtilization = ReturnType<typeof rateLimitService.getRawUtilization>
type RateLimitSnapshot = typeof rateLimitService.currentLimits
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
