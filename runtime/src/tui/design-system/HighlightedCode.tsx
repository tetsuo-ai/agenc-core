import React, { memo, useEffect, useState } from 'react'
import { extname } from 'node:path'
import { Ansi, Box, Text } from '../ink-public.js'
import {
  type CliHighlight,
  getCliHighlightPromise,
} from '../_deps/cli-highlight.js'

type Props = {
  /** Code to render. */
  code: string
  /** File path used to detect language by extension. */
  filePath: string
  /** Optional explicit width hint. Currently informational only. */
  width?: number
  /** When true, renders the highlighted code with a dimmer foreground. */
  dim?: boolean
}

/**
 * Renders a code block with syntax highlighting via AgenC's `cli-highlight`
 * shim. Falls back to plain text when:
 *   - the optional `cli-highlight` dep is unavailable
 *   - the language inferred from `filePath` isn't supported
 *   - syntax highlighting is disabled by the caller
 *
 * The highlighter loads asynchronously, so the first render shows plain
 * text and the second swap-in shows the colorized version. This matches
 * the upstream contract.
 */
export const HighlightedCode = memo(function HighlightedCode({
  code,
  filePath,
  dim = false,
}: Props): React.ReactElement {
  const [highlighter, setHighlighter] = useState<CliHighlight | null>(null)

  useEffect(() => {
    let cancelled = false
    void getCliHighlightPromise().then(loaded => {
      if (!cancelled) setHighlighter(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  let rendered: string | null = null
  if (highlighter) {
    const language = inferLanguage(filePath)
    if (language && highlighter.supportsLanguage(language)) {
      try {
        rendered = highlighter.highlight(code, { language, ignoreIllegals: true })
      } catch {
        rendered = null
      }
    }
  }

  if (rendered !== null) {
    const lines = rendered.split('\n')
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i} dimColor={dim}>
            <Ansi>{line.length === 0 ? ' ' : line}</Ansi>
          </Text>
        ))}
      </Box>
    )
  }

  // Fallback: plain text.
  const lines = code.split('\n')
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} dimColor={dim}>
          {line.length === 0 ? ' ' : line}
        </Text>
      ))}
    </Box>
  )
})

function inferLanguage(filePath: string): string | undefined {
  const ext = extname(filePath).slice(1).toLowerCase()
  if (ext.length === 0) return undefined
  return ext
}
