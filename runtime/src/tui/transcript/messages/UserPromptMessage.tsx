/**
 * Renders a plain user prompt (the typed message that started a turn).
 * Truncates very large pasted/piped input so the Ink renderer doesn't
 * iterate the entire mounted text on every frame.
 */
import * as React from 'react'
import { useMemo } from 'react'

import { Box } from '../../ink-public.js'

import { HighlightedThinkingText } from './HighlightedThinkingText.js'
import { countCharInString } from './_helpers.js'

export interface UserPromptParam {
  readonly text: string
  readonly type?: 'text'
}

export interface UserPromptMessageProps {
  readonly addMargin: boolean
  readonly param: UserPromptParam
  readonly isTranscriptMode?: boolean
  readonly timestamp?: string
}

// Hard cap on displayed prompt text. Piping large files via stdin
// (e.g. `cat 11k-line-file | agenc`) creates a single user message whose
// <Text> node the fullscreen Ink renderer must wrap/output on every
// frame, causing keystroke latency. React.memo skips the React render
// but the Ink output pass still iterates the full mounted text.
// Head+tail because `{ cat file; echo prompt; } | agenc` puts the
// user's actual question at the end.
const MAX_DISPLAY_CHARS = 10_000
const TRUNCATE_HEAD_CHARS = 2_500
const TRUNCATE_TAIL_CHARS = 2_500

export function UserPromptMessage({
  addMargin,
  param: { text },
  // isTranscriptMode and timestamp are forwarded so callers can pass
  // them through without adapter shims. The brief-layout branch in
  // HighlightedThinkingText reads timestamp; AgenC does not yet have a
  // viewing-agent-task or brief-only mode toggle, so brief layout
  // stays off here.
  isTranscriptMode: _isTranscriptMode,
  timestamp,
}: UserPromptMessageProps): React.ReactNode {
  const displayText = useMemo(() => {
    if (text.length <= MAX_DISPLAY_CHARS) return text
    const head = text.slice(0, TRUNCATE_HEAD_CHARS)
    const tail = text.slice(-TRUNCATE_TAIL_CHARS)
    const hiddenLines =
      countCharInString(text, '\n', TRUNCATE_HEAD_CHARS) -
      countCharInString(tail, '\n')
    return `${head}\n… +${hiddenLines} lines …\n${tail}`
  }, [text])

  if (!text) return null

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} paddingRight={1}>
      <HighlightedThinkingText text={displayText} timestamp={timestamp} />
    </Box>
  )
}
