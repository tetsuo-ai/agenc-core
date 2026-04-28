/**
 * Shared helpers used by the user-input message renderers. Kept
 * private to `messages/` (filename starts with `_`) so the rest of
 * the TUI doesn't import these by accident — anything generally
 * useful should be promoted to a sibling utility module.
 */
import * as React from 'react'

import { Box, Text } from '../../ink-public.js'

/**
 * Extracts inner content of an `<tagName>...</tagName>` block from a
 * piece of XML-tagged user input text. Handles attributes and same-tag
 * nesting; returns `null` when the tag is not present.
 */
export function extractTag(html: string, tagName: string): string | null {
  if (!html.trim() || !tagName.trim()) return null

  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const pattern = new RegExp(
    `<${escapedTag}(?:\\s+[^>]*)?>` + '([\\s\\S]*?)' + `<\\/${escapedTag}>`,
    'gi',
  )
  const openingTag = new RegExp(`<${escapedTag}(?:\\s+[^>]*?)?>`, 'gi')
  const closingTag = new RegExp(`<\\/${escapedTag}>`, 'gi')

  let match: RegExpExecArray | null
  let lastIndex = 0
  while ((match = pattern.exec(html)) !== null) {
    const content = match[1]
    const beforeMatch = html.slice(lastIndex, match.index)

    let depth = 0
    openingTag.lastIndex = 0
    while (openingTag.exec(beforeMatch) !== null) depth++
    closingTag.lastIndex = 0
    while (closingTag.exec(beforeMatch) !== null) depth--

    if (depth === 0 && content) return content

    lastIndex = match.index + match[0].length
  }
  return null
}

/**
 * Counts occurrences of `char` in `str`.
 */
export function countCharInString(
  str: string,
  char: string,
  start = 0,
): number {
  let count = 0
  let i = str.indexOf(char, start)
  while (i !== -1) {
    count++
    i = str.indexOf(char, i + 1)
  }
  return count
}

/**
 * Two-column "response" row used by user-message follow-ups: a fixed
 * 4-cell gutter showing the dim `⎿` glyph, then the actual content.
 */
export function MessageResponse({
  children,
  height,
}: {
  children: React.ReactNode
  height?: number
}): React.ReactNode {
  return (
    <Box flexDirection="row" {...(height !== undefined ? { height } : {})}>
      <Box flexShrink={0}>
        <Text dimColor>{'  ⎿  '}</Text>
      </Box>
      <Box flexShrink={1} flexGrow={1}>
        {children}
      </Box>
    </Box>
  )
}

/**
 * Sentinel strings used when a turn was interrupted by the operator.
 */
export const INTERRUPT_MESSAGE = '[Request interrupted by user]'
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  '[Request interrupted by user for tool use]'

/**
 * Display sentinel emitted by the runtime when a tool result has no
 * content.
 */
export const NO_CONTENT_MESSAGE = '(no content)'

/**
 * XML tag names used to mark user input variants.
 */
export const COMMAND_MESSAGE_TAG = 'command-message'
export const LOCAL_COMMAND_CAVEAT_TAG = 'local-command-caveat'
export const TICK_TAG = 'tick'

/**
 * Renders the "interrupted by user" notice used inline in the
 * transcript. Plain English; AgenC has no localization layer yet.
 */
export function InterruptedByUser(): React.ReactNode {
  return <Text color="error">Interrupted by user</Text>
}
