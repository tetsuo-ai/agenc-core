import { useContext } from 'react'
import {
  type TerminalSize,
  TerminalSizeContext,
} from '../ink/components/TerminalSizeContext.js'

/**
 * Returns the current terminal `{columns, rows}`. Throws when called
 * outside an Ink App tree (the App component installs the
 * TerminalSizeContext provider).
 */
export function useTerminalSize(): TerminalSize {
  const size = useContext(TerminalSizeContext)

  if (!size) {
    throw new Error('useTerminalSize must be used within an Ink App component')
  }

  return size
}
