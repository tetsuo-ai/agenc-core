/**
 * CompactSummary
 *
 * Ported from upstream. Visual indicator that the conversation has been
 * compacted (auto- or manual-triggered) — shows a short header line
 * plus, in transcript mode, the full text content of the summarizer's
 * output.
 *
 * The host passes already-extracted display fields rather than the full
 * AgenC result so this widget stays purely presentational.
 */

import React from 'react'

import { Box, Text } from '../ink-public.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

const BLACK_CIRCLE = '●'

export interface CompactSummaryMetadata {
  /** Number of messages folded into the summary. */
  readonly messagesSummarized: number
  /**
   * Whether the summary covers all messages up to its position
   * (`'up_to'`) or rewrites the conversation forward from this point
   * (`'from'`).
   */
  readonly direction: 'up_to' | 'from'
  /** Optional operator-supplied note that triggered the compaction. */
  readonly userContext?: string
}

export interface CompactSummaryProps {
  /**
   * Plain-text rendering of the summarizer's response. Surfaced in
   * transcript mode so the operator can scroll back into the full
   * summary.
   */
  readonly textContent: string
  /**
   * Optional metadata block describing what was compacted. When
   * present, the widget renders the rich "Summarized conversation"
   * header; when absent it falls back to the lightweight inline
   * "Compact summary" marker.
   */
  readonly metadata?: CompactSummaryMetadata
  /**
   * Whether the consuming surface is the transcript pane. Transcript
   * mode shows the full summary text; the chat pane only shows the
   * summary header to keep the live conversation tight.
   */
  readonly transcriptMode?: boolean
  /**
   * Display string for the "expand" shortcut. Defaults to `ctrl+o`,
   * which matches AgenC's `app:toggleTranscript` default binding.
   */
  readonly expandShortcut?: string
}

export function CompactSummary({
  textContent,
  metadata,
  transcriptMode = false,
  expandShortcut = 'ctrl+o',
}: CompactSummaryProps): React.ReactElement {
  if (metadata) {
    const directionPhrase =
      metadata.direction === 'up_to' ? 'up to this point' : 'from this point'
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Box minWidth={2}>
            <Text>{BLACK_CIRCLE}</Text>
          </Box>
          <Box flexDirection="column">
            <Text bold={true}>Summarized conversation</Text>
            {!transcriptMode ? (
              <Box flexDirection="column">
                <Text dimColor={true}>
                  {`Summarized ${metadata.messagesSummarized} messages ${directionPhrase}`}
                </Text>
                {metadata.userContext ? (
                  <Text dimColor={true}>
                    {`Context: “${metadata.userContext}”`}
                  </Text>
                ) : null}
                <Text dimColor={true}>
                  <KeyboardShortcutHint
                    shortcut={expandShortcut}
                    action="expand history"
                    parens={true}
                  />
                </Text>
              </Box>
            ) : null}
            {transcriptMode ? <Text>{textContent}</Text> : null}
          </Box>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text>{BLACK_CIRCLE}</Text>
        </Box>
        <Box flexDirection="column">
          <Text bold={true}>
            Compact summary
            {!transcriptMode ? (
              <Text dimColor={true}>
                {' '}
                <KeyboardShortcutHint
                  shortcut={expandShortcut}
                  action="expand"
                  parens={true}
                />
              </Text>
            ) : null}
          </Text>
        </Box>
      </Box>
      {transcriptMode ? <Text>{textContent}</Text> : null}
    </Box>
  )
}

export default CompactSummary
