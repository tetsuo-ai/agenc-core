import React, { useState } from 'react'
import { useInterval } from '../ink/hooks/use-interval.js'
import Text from './ThemedText.js'

const SPINNER_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const

const FRAME_INTERVAL_MS = 80

/**
 * A minimal single-character spinner.
 *
 * Renders one rotating brail-dots glyph driven by the shared animation
 * clock. Use it in place of the upstream Spinner whenever a small inline
 * progress indicator is needed (e.g. inside `LoadingState`).
 *
 * The full upstream spinner with verbs, teammate trees, and brief mode is
 * a separate, much larger component that pulls in many runtime-specific
 * subsystems; this minimal version intentionally stays scoped to the
 * single-glyph case.
 */
export function Spinner(): React.ReactElement {
  const [frame, setFrame] = useState(0)
  useInterval(() => {
    setFrame(prev => (prev + 1) % SPINNER_FRAMES.length)
  }, FRAME_INTERVAL_MS)
  return <Text color="accent">{SPINNER_FRAMES[frame]}</Text>
}
