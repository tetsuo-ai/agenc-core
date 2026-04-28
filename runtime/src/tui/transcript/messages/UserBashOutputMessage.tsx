/**
 * Renders the result of a `!cmd` bash invocation. AgenC's `ExecCell`
 * already covers shell tool output, but the bash-shorthand path is
 * currently a plain user message in the transcript, so we render
 * stdout/stderr inline with the same indented gutter style as other
 * user-message follow-ups.
 *
 * TODO(tranche-5): once the AgenC bash-shorthand path lands an
 * AgenC-native result renderer (analogous to `ExecCell`), swap this
 * for that component so terminal output gets the same collapse /
 * truncate treatment as other shell-tool results.
 */
import * as React from 'react'

import { Box, Text } from '../../ink-public.js'

import { extractTag, MessageResponse } from './_helpers.js'

export interface UserBashOutputMessageProps {
  readonly content: string
  readonly verbose?: boolean
}

export function UserBashOutputMessage({
  content,
  verbose: _verbose,
}: UserBashOutputMessageProps): React.ReactNode {
  const rawStdout = extractTag(content, 'bash-stdout') ?? ''
  const stdout = extractTag(rawStdout, 'persisted-output') ?? rawStdout
  const stderr = extractTag(content, 'bash-stderr') ?? ''

  const stdoutTrim = stdout.trim()
  const stderrTrim = stderr.trim()
  if (!stdoutTrim && !stderrTrim) {
    return (
      <MessageResponse>
        <Text dimColor>(no output)</Text>
      </MessageResponse>
    )
  }

  return (
    <Box flexDirection="column">
      {stdoutTrim ? (
        <MessageResponse>
          <Text>{stdoutTrim}</Text>
        </MessageResponse>
      ) : null}
      {stderrTrim ? (
        <MessageResponse>
          <Text color="error">{stderrTrim}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  )
}
