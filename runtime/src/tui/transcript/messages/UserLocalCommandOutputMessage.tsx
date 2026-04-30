/**
 * Renders the stdout/stderr emitted by a local command run on the
 * operator's machine (e.g. an editor extension or sidecar tool).
 * Wrapped in `<local-command-stdout>` / `<local-command-stderr>` tags
 * by the runtime so it can be distinguished from regular bash output.
 *
 * The "diamond" branch (`◇` / `◆` prefix) decorates lines emitted by
 * cloud-launch style helpers — those messages start with
 * `◇ Label · suffix\n…body`. Plain output gets the dim `⎿` gutter.
 *
 * TODO(tranche-5): wire to AgenC IDE bridge once ported. The current
 * version only renders the inline text — when the AgenC sidecar lands
 * support for structured cloud-launch payloads, restore the rich
 * `CloudLaunchContent` styling.
 */
import * as React from 'react'

import { Box, Text } from '../../ink-public.js'

import { Markdown } from '../../components/Markdown.js'
import FullWidthRow from '../../design-system/FullWidthRow.js'

import {
  extractTag,
  MessageResponse,
  NO_CONTENT_MESSAGE,
} from './_helpers.js'

export interface UserLocalCommandOutputMessageProps {
  readonly content: string
}

const DIAMOND_OPEN = '◇'
const DIAMOND_FILLED = '◆'

export function UserLocalCommandOutputMessage({
  content,
}: UserLocalCommandOutputMessageProps): React.ReactNode {
  const stdout = extractTag(content, 'local-command-stdout')
  const stderr = extractTag(content, 'local-command-stderr')

  if (!stdout && !stderr) {
    return (
      <MessageResponse>
        <Text dimColor>{NO_CONTENT_MESSAGE}</Text>
      </MessageResponse>
    )
  }

  const lines: React.ReactNode[] = []
  const trimmedStdout = stdout?.trim()
  if (trimmedStdout) {
    lines.push(<IndentedContent key="stdout">{trimmedStdout}</IndentedContent>)
  }
  const trimmedStderr = stderr?.trim()
  if (trimmedStderr) {
    lines.push(<IndentedContent key="stderr">{trimmedStderr}</IndentedContent>)
  }
  return <>{lines}</>
}

function IndentedContent({
  children,
}: {
  children: string
}): React.ReactNode {
  if (
    children.startsWith(`${DIAMOND_OPEN} `) ||
    children.startsWith(`${DIAMOND_FILLED} `)
  ) {
    return <CloudLaunchContent>{children}</CloudLaunchContent>
  }
  return (
    <FullWidthRow>
      <Text dimColor>{'  ⎿  '}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown>{children}</Markdown>
      </Box>
    </FullWidthRow>
  )
}

function CloudLaunchContent({
  children,
}: {
  children: string
}): React.ReactNode {
  const diamond = children[0] ?? ''
  const nl = children.indexOf('\n')
  const header = nl === -1 ? children.slice(2) : children.slice(2, nl)
  const rest = nl === -1 ? '' : children.slice(nl + 1).trim()
  const sep = header.indexOf(' · ')
  const label = sep === -1 ? header : header.slice(0, sep)
  const suffix = sep === -1 ? '' : header.slice(sep)

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="surface">{diamond} </Text>
        <Text bold>{label}</Text>
        {suffix ? <Text dimColor>{suffix}</Text> : null}
      </Text>
      {rest ? (
        <FullWidthRow>
          <Text dimColor>{'  ⎿  '}</Text>
          <Text dimColor>{rest}</Text>
        </FullWidthRow>
      ) : null}
    </Box>
  )
}
