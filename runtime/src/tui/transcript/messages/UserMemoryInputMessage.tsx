/**
 * Renders the `# memory` shorthand: when the user prefixes their
 * composer input with `#`, the runtime appends the line to the
 * project's `AGENC.md` file (with the per-checkout
 * `AGENC.override.md` shadow taking precedence) and tags the line
 * with `<user-memory-input>` so the transcript shows it as a memory
 * write rather than an LLM prompt.
 */
import * as React from 'react'

import { Box, Text } from '../../ink-public.js'

import { extractTag, MessageResponse } from './_helpers.js'

export interface UserMemoryInputMessageProps {
  readonly addMargin: boolean
  readonly text: string
}

const SAVING_MESSAGES = ['Got it.', 'Good to know.', 'Noted.'] as const

function pickSavingMessage(): string {
  const index = Math.floor(Math.random() * SAVING_MESSAGES.length)
  return SAVING_MESSAGES[index] ?? SAVING_MESSAGES[0]
}

export function UserMemoryInputMessage({
  addMargin,
  text,
}: UserMemoryInputMessageProps): React.ReactNode {
  const input = extractTag(text, 'user-memory-input')
  // Pick once per mount — re-renders on scroll keep the same word.
  const savingText = React.useMemo(() => pickSavingMessage(), [])

  if (!input) return null

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} width="100%">
      <Box>
        <Text color="accent">#</Text>
        <Text>{` ${input} `}</Text>
      </Box>
      <MessageResponse height={1}>
        <Text dimColor>{savingText} Saved to AGENC.md</Text>
      </MessageResponse>
    </Box>
  )
}
