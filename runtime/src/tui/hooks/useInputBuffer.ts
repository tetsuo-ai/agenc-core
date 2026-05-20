import { useCallback, useRef, useState } from 'react'
import type { PastedContent } from '../../utils/config.js' // upstream-import: keep target is owned by another Z-PURGE item

export type BufferEntry = {
  text: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
  timestamp: number
}

export type UseInputBufferProps = {
  maxBufferSize: number
  debounceMs: number
}

export type UseInputBufferResult = {
  pushToBuffer: (
    text: string,
    cursorOffset: number,
    pastedContents?: Record<number, PastedContent>,
  ) => void
  undo: () => BufferEntry | undefined
  canUndo: boolean
  clearBuffer: () => void
}

export function useInputBuffer({
  maxBufferSize,
  debounceMs,
}: UseInputBufferProps): UseInputBufferResult {
  const [{ buffer, currentIndex }, setBufferState] = useState<{
    buffer: BufferEntry[]
    currentIndex: number
  }>({ buffer: [], currentIndex: -1 })
  const lastPushTime = useRef<number>(0)
  const pendingPush = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pushToBuffer = useCallback(
    (
      text: string,
      cursorOffset: number,
      pastedContents: Record<number, PastedContent> = {},
    ) => {
      const now = Date.now()

      // Clear any pending push
      if (pendingPush.current) {
        clearTimeout(pendingPush.current)
        pendingPush.current = null
      }

      // Debounce rapid changes
      if (now - lastPushTime.current < debounceMs) {
        pendingPush.current = setTimeout(
          pushToBuffer,
          debounceMs,
          text,
          cursorOffset,
          pastedContents,
        )
        return
      }

      lastPushTime.current = now

      setBufferState(prevState => {
        // If we're not at the end of the buffer, truncate everything after current position
        const newBuffer =
          prevState.currentIndex >= 0
            ? prevState.buffer.slice(0, prevState.currentIndex + 1)
            : prevState.buffer

        // Don't add if it's the same as the last entry
        const lastEntry = newBuffer[newBuffer.length - 1]
        if (lastEntry && lastEntry.text === text) {
          return {
            buffer: newBuffer,
            currentIndex: newBuffer.length - 1,
          }
        }

        // Add new entry
        const updatedBuffer = [
          ...newBuffer,
          { text, cursorOffset, pastedContents, timestamp: now },
        ]

        // Limit buffer size
        const limitedBuffer =
          updatedBuffer.length > maxBufferSize
            ? updatedBuffer.slice(-maxBufferSize)
            : updatedBuffer

        return {
          buffer: limitedBuffer,
          currentIndex: limitedBuffer.length - 1,
        }
      })
    },
    [debounceMs, maxBufferSize],
  )

  const undo = useCallback((): BufferEntry | undefined => {
    if (currentIndex < 0 || buffer.length === 0) {
      return undefined
    }

    const targetIndex = Math.max(0, currentIndex - 1)
    const entry = buffer[targetIndex]

    if (entry) {
      setBufferState(prevState => ({
        ...prevState,
        currentIndex: Math.min(targetIndex, prevState.buffer.length - 1),
      }))
      return entry
    }

    return undefined
  }, [buffer, currentIndex])

  const clearBuffer = useCallback(() => {
    setBufferState({ buffer: [], currentIndex: -1 })
    lastPushTime.current = 0
    if (pendingPush.current) {
      clearTimeout(pendingPush.current)
      pendingPush.current = null
    }
  }, [lastPushTime, pendingPush])

  const canUndo = currentIndex > 0 && buffer.length > 1

  return {
    pushToBuffer,
    undo,
    canUndo,
    clearBuffer,
  }
}
