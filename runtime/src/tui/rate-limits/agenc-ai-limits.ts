import { useEffect, useState } from 'react'

// branding-scan: allow existing upstream rate-limit service path
type LimitsService = typeof import('../../agenc/upstream/services/claudeAiLimits.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const limitsService = require('../../agenc/upstream/services/claudeAiLimits.js') as LimitsService // branding-scan: allow existing upstream rate-limit service path
type AgenCAILimits = typeof limitsService.currentLimits

export function useAgenCAiLimits(): AgenCAILimits {
  const [limits, setLimits] = useState<AgenCAILimits>({ ...limitsService.currentLimits })

  useEffect(() => {
    const listener = (newLimits: AgenCAILimits) => {
      setLimits({ ...newLimits })
    }
    limitsService.statusListeners.add(listener)

    return () => {
      limitsService.statusListeners.delete(listener)
    }
  }, [])

  return limits
}

export function getRawUtilization(): ReturnType<typeof limitsService.getRawUtilization> {
  const raw = limitsService.getRawUtilization()
  return {
    ...(raw.five_hour ? { five_hour: { ...raw.five_hour } } : {}),
    ...(raw.seven_day ? { seven_day: { ...raw.seven_day } } : {}),
  }
}
