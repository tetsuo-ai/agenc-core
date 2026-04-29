/**
 * RateLimitMessage — renders a rate-limit warning row in the transcript.
 *
 * Adapted from the upstream rate-limit row component.
 *
 * AgenC scope notes:
 *   - The upstream upsell pipeline (subscription tier checks,
 *     `/extra-usage`, `/upgrade`, billing-account-aware copy, the
 *     "rate-limit options" auto-open menu) is dropped. AgenC has no
 *     subscription tier surface to upsell, so the row is a single
 *     error-colored message with an optional dim subline showing when
 *     the limit resets.
 *   - The upstream subscription/limits service hooks don't exist in
 *     AgenC. Callers pass the raw payload directly.
 *
 * @module
 */

import React from 'react'

import { Box, Text } from '../../ink-public.js'

export interface RateLimitMessageProps {
  /** The rate-limit error message text to render in error color. */
  readonly text: string
  /**
   * Optional human-readable reset time (e.g. "in 4m 12s" or
   * "at 14:30 UTC"). Rendered dim below the main text when present.
   */
  readonly resetsAt?: string
  /**
   * Optional secondary hint (e.g. "Try again later" or a runtime
   * suggestion). Dim, follows `resetsAt`.
   */
  readonly hint?: string
}

export function RateLimitMessage({
  text,
  resetsAt,
  hint,
}: RateLimitMessageProps): React.ReactElement | null {
  if (typeof text !== 'string' || text.length === 0) {
    return null
  }
  return (
    <Box flexDirection="column">
      <Text color="error">{text}</Text>
      {resetsAt ? <Text dimColor>{`Resets ${resetsAt}`}</Text> : null}
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  )
}

export default RateLimitMessage
