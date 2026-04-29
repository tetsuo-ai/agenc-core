/**
 * UserTeammateMessage — renders a row when a subagent (teammate) sends a
 * message into the parent transcript.
 *
 * Adapted from the upstream teammate-message row component.
 *
 * AgenC scope notes:
 *   - The upstream parser walks an XML-tagged `<teammate-message ...>`
 *     blob to extract `teammateId`, `color`, and `summary`. AgenC's runtime
 *     emits `collab_agent_interaction_*` events with typed payloads, so
 *     the XML parser is dropped — callers pass typed `TeammateMessage`
 *     objects directly.
 *   - Per-agent custom colors do not exist in AgenC's thread state
 *     (`{ threadId, role, status, label?, model? }`). The renderer uses
 *     the `accent` brand color as the default and only honors `color` if
 *     the caller explicitly passes one.
 *   - Plan approval / shutdown / task assignment dispatch is delegated to
 *     the sibling `PlanApprovalMessage`, `ShutdownMessage`, and
 *     `TaskAssignmentMessage` files. Callers decide which subview to
 *     render based on the typed event payload, not by parsing JSON
 *     strings out of the message body.
 *   - Idle notifications and `teammate_terminated` lifecycle filtering
 *     happens in the dispatcher (i.e., `events-to-messages`); this
 *     component only handles the visible "@name → body" row.
 *
 * @module
 */

import React from 'react'

import { Box, Text } from '../../ink-public.js'
import type { Color } from '../../ink/styles.js'
import { glyphs } from '../../design-system/glyphs.js'

export interface TeammateMessage {
  /**
   * Display name for the row's "@name" header. In AgenC this is the
   * subagent's nickname or role label. The reserved upstream `leader`
   * id maps to literal "leader" if a caller still passes it through.
   */
  readonly displayName: string
  /** Plain message body. */
  readonly content: string
  /**
   * Optional explicit color override. AgenC's thread state does not
   * carry per-agent colors, so the default is the brand `accent`
   * color resolved by the caller.
   */
  readonly color?: Color
  /** Optional one-line summary shown next to the "@name" header. */
  readonly summary?: string
}

export interface UserTeammateMessageProps {
  readonly messages: readonly TeammateMessage[]
  /** Insert a top margin on the outer container. */
  readonly addMargin?: boolean
  /**
   * In transcript mode the full body is shown indented under the header.
   * In condensed mode only the summary (and "@name") line renders.
   */
  readonly isTranscriptMode?: boolean
}

export function UserTeammateMessage({
  messages,
  addMargin = false,
  isTranscriptMode = false,
}: UserTeammateMessageProps): React.ReactElement | null {
  if (!Array.isArray(messages) || messages.length === 0) return null

  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      width="100%"
    >
      {messages.map((msg, index) => (
        <TeammateMessageContent
          key={`${msg.displayName}-${index}`}
          displayName={msg.displayName}
          color={msg.color}
          content={msg.content}
          summary={msg.summary}
          isTranscriptMode={isTranscriptMode}
        />
      ))}
    </Box>
  )
}

interface TeammateMessageContentProps {
  readonly displayName: string
  readonly color?: Color
  readonly content: string
  readonly summary?: string
  readonly isTranscriptMode?: boolean
}

export function TeammateMessageContent({
  displayName,
  color,
  content,
  summary,
  isTranscriptMode,
}: TeammateMessageContentProps): React.ReactElement {
  const headerLabel = `@${displayName}${glyphs.pointer}`
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={color}>{headerLabel}</Text>
        {summary ? <Text>{` ${summary}`}</Text> : null}
      </Box>
      {isTranscriptMode ? (
        <Box paddingLeft={2}>
          <Text>{content}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export default UserTeammateMessage
