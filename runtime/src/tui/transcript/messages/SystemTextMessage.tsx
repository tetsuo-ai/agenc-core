/**
 * SystemTextMessage — renders a generic system status row in the transcript.
 *
 * Adapted from the upstream system-text row component.
 *
 * AgenC scope notes:
 *   - The big upstream subtype dispatch (turn_duration, memory_saved,
 *     bridge_status, scheduled_task_fire, permission_retry, agents_killed,
 *     stop_hook_summary, away_summary, thinking) is dropped here. AgenC's
 *     reducer emits separate `meta`/`error`/`warning` rows and dedicated
 *     dispatchers (e.g., `RateLimitMessage`, `SystemAPIErrorMessage`) for
 *     the variants that survive the AgenC scope cut.
 *   - The remaining behavior is the plain "system text" row: a leading
 *     bullet (when level !== "info") plus the message body, dim when info.
 *
 * @module
 */

import React from 'react'

import { Box, Text } from '../../ink-public.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { theme } from '../../theme.js'

const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●'

export type SystemMessageLevel = 'info' | 'warning' | 'error'

export interface SystemTextMessageProps {
  /** The text content to render. */
  readonly content: string
  /** Severity level — controls bullet visibility, color, and dimming. */
  readonly level?: SystemMessageLevel
  /** Insert a top margin between this row and the previous one. */
  readonly addMargin?: boolean
  /** When `false` and `level === 'info'`, the row is suppressed. */
  readonly verbose?: boolean
}

export function SystemTextMessage({
  content,
  level = 'info',
  addMargin = false,
  verbose = false,
}: SystemTextMessageProps): React.ReactElement | null {
  if (typeof content !== 'string' || content.length === 0) {
    return null
  }
  if (!verbose && level === 'info') {
    return null
  }

  const showDot = level !== 'info'
  const isWarning = level === 'warning'
  const isError = level === 'error'
  const dimColor = level === 'info'

  const dotColor = isError
    ? theme.colors.error
    : isWarning
      ? theme.colors.warning
      : theme.colors.dim
  const textColor = isError
    ? theme.colors.error
    : isWarning
      ? theme.colors.warning
      : undefined

  return (
    <Box flexDirection="row" width="100%">
      <SystemTextMessageInner
        content={content}
        addMargin={addMargin}
        showDot={showDot}
        dotColor={dotColor}
        textColor={textColor}
        dimColor={dimColor}
      />
    </Box>
  )
}

interface InnerProps {
  readonly content: string
  readonly addMargin: boolean
  readonly showDot: boolean
  readonly dotColor: string
  readonly textColor: string | undefined
  readonly dimColor: boolean
}

function SystemTextMessageInner({
  content,
  addMargin,
  showDot,
  dotColor,
  textColor,
  dimColor,
}: InnerProps): React.ReactElement {
  const { columns } = useTerminalSize()
  const marginTop = addMargin ? 1 : 0
  const bodyWidth = Math.max(0, columns - 10)

  return (
    <Box flexDirection="row" marginTop={marginTop} width="100%">
      {showDot ? (
        <Box minWidth={2}>
          <Text color={dotColor}>{BLACK_CIRCLE}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" width={bodyWidth}>
        <Text color={textColor} dimColor={dimColor} wrap="wrap">
          {content.trim()}
        </Text>
      </Box>
    </Box>
  )
}

export default SystemTextMessage
