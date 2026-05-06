import { useEffect, useState } from 'react'
import {
  type AgenCAILimits,
  currentLimits,
  statusListeners,
} from './agencAiLimits.js'

export function useAgenCAiLimits(): AgenCAILimits {
  const [limits, setLimits] = useState<AgenCAILimits>({ ...currentLimits })

  useEffect(() => {
    const listener = (newLimits: AgenCAILimits) => {
      setLimits({ ...newLimits })
    }
    statusListeners.add(listener)

    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return limits
}
