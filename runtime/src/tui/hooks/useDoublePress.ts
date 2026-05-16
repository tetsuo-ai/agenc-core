// Creates a function that calls one function on the first call and another
// function on the second call within a certain timeout

import { useCallback, useEffect, useRef } from 'react'

export const DOUBLE_PRESS_TIMEOUT_MS = 800

type SharedDoublePressState = {
  lastPress: number
  token: number
}

const sharedDoublePressState = new Map<string, SharedDoublePressState>()

export function useDoublePress(
  setPending: (pending: boolean) => void,
  onDoublePress: () => void,
  onFirstPress?: () => void,
  sharedKey?: string,
): () => void {
  const lastPressRef = useRef<number>(0)
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)

  const clearTimeoutSafe = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = undefined
    }
  }, [])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      clearTimeoutSafe()
    }
  }, [clearTimeoutSafe])

  return useCallback(() => {
    const now = Date.now()
    const sharedState =
      sharedKey !== undefined
        ? sharedDoublePressState.get(sharedKey) ?? { lastPress: 0, token: 0 }
        : undefined
    const lastPress = sharedState?.lastPress ?? lastPressRef.current
    const timeSinceLastPress = now - lastPress
    const isDoublePress =
      timeSinceLastPress <= DOUBLE_PRESS_TIMEOUT_MS &&
      (sharedKey !== undefined
        ? sharedState !== undefined
        : timeoutRef.current !== undefined)

    if (isDoublePress) {
      // Double press detected
      clearTimeoutSafe()
      setPending(false)
      onDoublePress()
    } else {
      // First press
      onFirstPress?.()
      setPending(true)

      // Clear any existing timeout and set new one
      clearTimeoutSafe()
      const token = (sharedState?.token ?? 0) + 1
      if (sharedKey !== undefined) {
        sharedDoublePressState.set(sharedKey, { lastPress: now, token })
      }
      timeoutRef.current = setTimeout(
        (setPending, timeoutRef, sharedKey, token) => {
          setPending(false)
          timeoutRef.current = undefined
          if (sharedKey !== undefined) {
            const shared = sharedDoublePressState.get(sharedKey)
            if (shared?.token === token) sharedDoublePressState.delete(sharedKey)
          }
        },
        DOUBLE_PRESS_TIMEOUT_MS,
        setPending,
        timeoutRef,
        sharedKey,
        token,
      )
    }

    lastPressRef.current = now
    if (sharedKey !== undefined && isDoublePress) {
      sharedDoublePressState.delete(sharedKey)
    }
  }, [setPending, onDoublePress, onFirstPress, clearTimeoutSafe, sharedKey])
}
