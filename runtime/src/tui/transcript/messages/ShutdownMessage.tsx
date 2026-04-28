/**
 * ShutdownMessage — renders subagent / session shutdown lifecycle rows.
 *
 * Adapted from the upstream shutdown lifecycle row components.
 *
 * AgenC scope notes:
 *   - The upstream `teammateMailbox` parsing helpers (`isShutdownRequest`,
 *     `isShutdownRejected`, `isShutdownApproved`) live in a module we
 *     are not porting (the upstream per-named-agent swarm shape is
 *     replaced by AgenC's thread-manager state). The visual components
 *     are preserved here so the dispatcher can hand them plain
 *     `{ from, reason }` payloads sourced from `collab_agent_*` /
 *     `collab_close_*` events.
 *   - `tryRenderShutdownMessage` is dropped — it was a JSON-string parser
 *     for the upstream mailbox. The AgenC dispatcher decides which
 *     subview to show based on the typed event payload.
 *
 * @module
 */

import React from 'react'

import { Box, Text } from '../../ink-public.js'

export interface ShutdownRequest {
  /** Display name / nickname of the agent requesting shutdown. */
  readonly from: string
  /** Optional human-readable reason. */
  readonly reason?: string
}

export interface ShutdownRejected {
  /** Display name / nickname of the agent that rejected the request. */
  readonly from: string
  /** Reason the agent declined to shut down. */
  readonly reason: string
}

/**
 * Renders a shutdown request with a warning-colored border.
 */
export function ShutdownRequestDisplay({
  request,
}: {
  readonly request: ShutdownRequest
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        borderStyle="round"
        borderColor="warning"
        flexDirection="column"
        paddingX={1}
        paddingY={1}
      >
        <Box marginBottom={1}>
          <Text color="warning" bold>
            {`Shutdown request from ${request.from}`}
          </Text>
        </Box>
        {request.reason ? (
          <Box>
            <Text>{`Reason: ${request.reason}`}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

/**
 * Renders a shutdown rejected message with a dim border and follow-up hint.
 */
export function ShutdownRejectedDisplay({
  response,
}: {
  readonly response: ShutdownRejected
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        borderStyle="round"
        borderColor="dim"
        flexDirection="column"
        paddingX={1}
        paddingY={1}
      >
        <Text color="dim" bold>
          {`Shutdown rejected by ${response.from}`}
        </Text>
        <Box
          marginTop={1}
          borderStyle="dashed"
          borderColor="dim"
          borderLeft={false}
          borderRight={false}
          paddingX={1}
        >
          <Text>{`Reason: ${response.reason}`}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {'Subagent is continuing to work. You may request shutdown again later.'}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

/**
 * Compact one-line shutdown status row. Used for inline transcript meta
 * rows like "Session ending…".
 */
export function ShutdownStatusLine({
  text,
}: {
  readonly text: string
}): React.ReactElement | null {
  if (typeof text !== 'string' || text.length === 0) return null
  return (
    <Box>
      <Text dimColor>{text}</Text>
    </Box>
  )
}

/**
 * Get a brief summary text for a shutdown lifecycle payload. Used in places
 * like the inbox queue where we want a short single-line description.
 */
export function getShutdownMessageSummary(
  payload:
    | { readonly kind: 'request'; readonly from: string; readonly reason?: string }
    | { readonly kind: 'approved'; readonly from: string }
    | { readonly kind: 'rejected'; readonly from: string; readonly reason: string },
): string {
  switch (payload.kind) {
    case 'request':
      return `[Shutdown Request from ${payload.from}]${payload.reason ? ` ${payload.reason}` : ''}`
    case 'approved':
      return `[Shutdown Approved] ${payload.from} is now exiting`
    case 'rejected':
      return `[Shutdown Rejected] ${payload.from}: ${payload.reason}`
  }
}

export default ShutdownStatusLine
