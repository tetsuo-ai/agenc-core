import React, { useMemo } from 'react'
import { Ansi, Box, NoSelect, Text } from '../ink-public.js'
import {
  type DiffDisplayLine,
  buildDiffDisplayLines,
} from '../_deps/diff-render.js'
import sliceAnsi from '../ink/vendored/sliceAnsi.js'
import { stringWidth } from '../ink/stringWidth.js'

type Props =
  | {
      /** Pre-built display lines from `buildDiffDisplayLines()`. */
      lines: readonly DiffDisplayLine[]
      patchText?: never
      width?: number
      dim?: boolean
    }
  | {
      /** Raw unified-diff text (e.g. tool output). */
      patchText: string
      lines?: never
      width?: number
      dim?: boolean
    }

/**
 * Render a unified diff using AgenC's watch-based diff pipeline.
 *
 * AgenC's diff renderer (`buildDiffDisplayLines`) returns ANSI-styled
 * display lines. This widget mirrors the upstream layout: when a non-empty
 * gutter prefix is present (line numbers / +/- markers), the gutter column
 * is wrapped in `<NoSelect fromLeftEdge>` so terminal copy-paste skips it.
 * Otherwise the lines render as a single column.
 *
 * Pass either `lines` (pre-built) or `patchText` (raw diff text). Width
 * defaults to undefined which lets Ink size the box naturally.
 */
export function StructuredDiff(props: Props): React.ReactElement | null {
  const { width, dim = false } = props

  const lines: readonly DiffDisplayLine[] = useMemo(() => {
    if ('lines' in props && props.lines) return props.lines
    if ('patchText' in props && typeof props.patchText === 'string') {
      return buildDiffDisplayLines({ kind: 'tool', body: props.patchText })
    }
    return []
  }, [props])

  if (lines.length === 0) return null

  // Detect a gutter column. We treat any leading non-whitespace prefix that
  // is shared up to the same character offset across most lines as the
  // gutter (line numbers + marker) — but for safety, we only split when
  // every line has the same plain-text prefix length up to the first
  // non-whitespace boundary that matches a digit or `+/-/ ` marker.
  const gutterWidth = computeGutterWidth(lines)

  if (gutterWidth > 0 && (width === undefined || gutterWidth < width)) {
    const gutters = lines.map(l => sliceAnsi(l.text, 0, gutterWidth))
    const contents = lines.map(l => sliceAnsi(l.text, gutterWidth))
    return (
      <Box flexDirection="row">
        <NoSelect fromLeftEdge={true}>
          <Box flexDirection="column">
            {gutters.map((g, i) => (
              <Text key={i} dimColor={dim}>
                <Ansi>{g}</Ansi>
              </Text>
            ))}
          </Box>
        </NoSelect>
        <Box flexDirection="column">
          {contents.map((c, i) => (
            <Text key={i} dimColor={dim}>
              <Ansi>{c}</Ansi>
            </Text>
          ))}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} dimColor={dim}>
          <Ansi>{l.text}</Ansi>
        </Text>
      ))}
    </Box>
  )
}

/**
 * Heuristic gutter detection: returns the width of the leading region that
 * looks like a line-number + diff-marker gutter (digits, spaces, and a
 * leading `+ -` marker). Returns 0 if no consistent gutter is detected.
 */
function computeGutterWidth(lines: readonly DiffDisplayLine[]): number {
  let candidate = -1
  for (const line of lines) {
    const plain = line.plainText ?? ''
    // Match leading: optional spaces + optional digits + space + marker(+/-/space)
    const m = plain.match(/^(\s*\d+\s+[+\- ])/)
    if (!m) return 0
    const w = stringWidth(m[1] ?? '')
    if (candidate === -1) {
      candidate = w
    } else if (candidate !== w) {
      // Inconsistent gutter widths — bail to single-column rendering.
      return 0
    }
  }
  return candidate > 0 ? candidate : 0
}
