/**
 * UserAgentNotificationMessage — renders a one-line subagent lifecycle
 * notification (e.g. "● task completed", "● task failed").
 *
 * Adapted from the upstream agent-notification row component.
 *
 * AgenC scope notes:
 *   - Upstream parses `<summary>` and `<status>` tags out of an Anthropic
 *     `TextBlockParam`. AgenC's runtime emits typed `collab_agent_spawn_end`
 *     payloads, so the parser is dropped — callers pass `summary` and
 *     `status` fields directly.
 *   - The status → color mapping mirrors upstream: `completed` → success,
 *     `failed` → error, `killed` → warning, anything else → no color.
 *
 * @module
 */

import React from 'react'

import { Box, Text } from '../../ink-public.js'

const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●'

export type AgentNotificationStatus =
  | 'completed'
  | 'failed'
  | 'killed'
  | (string & {})

export interface UserAgentNotificationMessageProps {
  /** One-line summary (e.g. "Task #abc-123 completed"). */
  readonly summary: string
  /** Lifecycle status used to color the leading bullet. */
  readonly status?: AgentNotificationStatus | null
  /** Insert a top margin between this row and the previous one. */
  readonly addMargin?: boolean
}

function getStatusColor(
  status: AgentNotificationStatus | null | undefined,
): 'success' | 'error' | 'warning' | undefined {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
      return 'warning'
    default:
      return undefined
  }
}

export function UserAgentNotificationMessage({
  summary,
  status,
  addMargin = false,
}: UserAgentNotificationMessageProps): React.ReactElement | null {
  if (typeof summary !== 'string' || summary.length === 0) return null
  const color = getStatusColor(status)
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color={color}>{BLACK_CIRCLE}</Text>
        {` ${summary}`}
      </Text>
    </Box>
  )
}

export default UserAgentNotificationMessage
