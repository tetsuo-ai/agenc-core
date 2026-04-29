import React from 'react'
import { pathToFileURL } from 'node:url'
import { Link } from '../ink-public.js'

type Props = {
  /** Absolute file path to link to. */
  filePath: string
  /** Optional display children (defaults to `filePath`). */
  children?: React.ReactNode
}

/**
 * Renders a file path as an OSC 8 hyperlink. This helps terminals like
 * iTerm correctly identify file paths even when they appear inside
 * parentheses or other surrounding text.
 */
export function FilePathLink({ filePath, children }: Props): React.ReactElement {
  const url = pathToFileURL(filePath).href
  return <Link url={url}>{children ?? filePath}</Link>
}
