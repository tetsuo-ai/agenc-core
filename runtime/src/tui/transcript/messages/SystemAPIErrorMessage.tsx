/**
 * SystemAPIErrorMessage — renders a transcript row for a provider/API error,
 * with a live retry countdown and "attempt N/M" footer.
 *
 * Adapted from the upstream API-error row component.
 *
 * AgenC scope notes:
 *   - The upstream `MessageResponse` wrapper and `CtrlOToExpand` keybinding
 *     hint are dropped — AgenC's transcript renders rows inline. The
 *     truncation affordance is preserved as a static dim hint when the
 *     formatted error exceeds `MAX_API_ERROR_CHARS`.
 *   - `formatAPIError` is replaced with a local `formatAPIError` that
 *     accepts a string or `Error`-like and prints a single readable line.
 *   - `useInterval` is replaced with the public Ink `useInterval` re-export
 *     (`tui/ink-public.ts`) so the row ticks a 1s countdown.
 *
 * @module
 */

import React, { useState } from 'react'

import { Box, Text } from '../../ink-public.js'
import { useInterval } from '../../ink/hooks/use-interval.js'

const MAX_API_ERROR_CHARS = 1000

export interface SystemAPIErrorPayload {
  readonly error: unknown
  /** 1-based retry attempt the runtime is about to make. */
  readonly retryAttempt: number
  /** Total retry attempts the runtime will perform before giving up. */
  readonly maxRetries: number
  /** Milliseconds until the runtime issues the next retry. */
  readonly retryInMs: number
}

export interface SystemAPIErrorMessageProps {
  readonly message: SystemAPIErrorPayload
  /**
   * When false, the formatted error is truncated to `MAX_API_ERROR_CHARS`
   * with a trailing ellipsis and a small expansion hint.
   */
  readonly verbose?: boolean
}

function formatAPIError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) {
    return error.message || String(error)
  }
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { message?: unknown }
    if (typeof maybe.message === 'string' && maybe.message.length > 0) {
      return maybe.message
    }
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

export function SystemAPIErrorMessage({
  message,
  verbose = false,
}: SystemAPIErrorMessageProps): React.ReactElement | null {
  const { retryAttempt, error, retryInMs, maxRetries } = message

  // Upstream hides the row until the 4th attempt to avoid spamming the
  // transcript on transient flakes. Preserve that quiet behavior here.
  const hidden = retryAttempt < 4

  const [countdownMs, setCountdownMs] = useState(0)
  const done = countdownMs >= retryInMs

  useInterval(
    () => {
      setCountdownMs((ms) => ms + 1000)
    },
    hidden || done ? null : 1000,
  )

  if (hidden) return null

  const formatted = formatAPIError(error)
  const truncated = !verbose && formatted.length > MAX_API_ERROR_CHARS
  const body = truncated
    ? formatted.slice(0, MAX_API_ERROR_CHARS) + '…'
    : formatted

  const retryInSecondsLive = Math.max(
    0,
    Math.round((retryInMs - countdownMs) / 1000),
  )
  const secondsWord = retryInSecondsLive === 1 ? 'second' : 'seconds'
  const apiTimeoutSuffix = process.env.API_TIMEOUT_MS
    ? ` · API_TIMEOUT_MS=${process.env.API_TIMEOUT_MS}ms, try increasing it`
    : ''

  return (
    <Box flexDirection="column">
      <Text color="error">{body}</Text>
      {truncated ? (
        <Text dimColor>{`(truncated · run with --verbose to see the full error)`}</Text>
      ) : null}
      <Text dimColor>
        {`Retrying in ${retryInSecondsLive} ${secondsWord}… (attempt ${retryAttempt}/${maxRetries})${apiTimeoutSuffix}`}
      </Text>
    </Box>
  )
}

export default SystemAPIErrorMessage
