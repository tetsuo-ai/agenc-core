import React from 'react'
import stripAnsi from 'strip-ansi'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Ansi } from '../ink-public.js'
import { stringWidth } from '../ink/stringWidth.js'
import { wrapAnsi } from '../ink/wrapAnsi.js'

/**
 * Accounts for parent indentation (e.g. message dot prefix) and terminal
 * resize races. Without enough margin the table overflows its layout box
 * and Ink's clip truncates differently on alternating frames, causing an
 * infinite flicker loop in scrollback.
 */
const SAFETY_MARGIN = 4

/** Minimum column width to prevent degenerate layouts. */
const MIN_COLUMN_WIDTH = 3

/**
 * Maximum number of lines per row before switching to vertical (key-value)
 * format.
 */
const MAX_ROW_LINES = 4

const ANSI_BOLD_START = '\x1b[1m'
const ANSI_BOLD_END = '\x1b[22m'

/** Column alignment, matching `marked.Tokens.Table.align`. */
export type CellAlign = 'left' | 'center' | 'right' | null

/**
 * Structural shape compatible with `marked.Tokens.Table`. Rather than
 * importing `marked` (not an AgenC runtime dep), callers build this shape
 * directly. Cells carry pre-rendered ANSI text via `text`.
 */
export type MarkdownTableToken = {
  header: ReadonlyArray<{ text: string }>
  align?: ReadonlyArray<CellAlign>
  rows: ReadonlyArray<ReadonlyArray<{ text: string }>>
}

type Props = {
  token: MarkdownTableToken
  /** Override terminal width (useful for testing). */
  forceWidth?: number
}

/**
 * Wrap text to fit within a given width, returning array of lines.
 * ANSI-aware via wrap-ansi; preserves styling across line breaks.
 *
 * @param hard - If true, break words that exceed width (needed when columns
 *   are narrower than the longest word).
 */
function wrapText(
  text: string,
  width: number,
  options?: { hard?: boolean },
): string[] {
  if (width <= 0) return [text]
  const trimmedText = text.trimEnd()
  const wrapped = wrapAnsi(trimmedText, width, {
    hard: options?.hard ?? false,
    trim: false,
    wordWrap: true,
  })
  const lines = wrapped.split('\n').filter(line => line.length > 0)
  return lines.length > 0 ? lines : ['']
}

/**
 * Pad an ANSI-styled cell value to the given display width, honoring
 * left / center / right alignment. The padded result preserves any ANSI
 * styling from the input and adds plain spaces for filler.
 */
function padAligned(
  value: string,
  valueWidth: number,
  cellWidth: number,
  align: CellAlign | undefined,
): string {
  const padding = Math.max(0, cellWidth - valueWidth)
  if (padding === 0) return value
  if (align === 'right') return ' '.repeat(padding) + value
  if (align === 'center') {
    const left = Math.floor(padding / 2)
    const right = padding - left
    return ' '.repeat(left) + value + ' '.repeat(right)
  }
  return value + ' '.repeat(padding)
}

/**
 * Renders a markdown table inline. Handles narrow terminals by:
 *   1. Computing minimum column widths from longest words.
 *   2. Distributing remaining space proportionally.
 *   3. Wrapping text within cells (no truncation).
 *   4. Falling back to a vertical (key-value) format when wrapping would
 *      make rows excessively tall or the table would overflow.
 */
export function MarkdownTable({
  token,
  forceWidth,
}: Props): React.ReactNode {
  const { columns: actualTerminalWidth } = useTerminalSize()
  const terminalWidth = forceWidth ?? actualTerminalWidth

  const formatCell = (cell: { text: string } | undefined): string =>
    cell?.text ?? ''

  const getPlainText = (cell: { text: string } | undefined): string =>
    stripAnsi(formatCell(cell))

  const getMinWidth = (cell: { text: string } | undefined): number => {
    const text = getPlainText(cell)
    const words = text.split(/\s+/).filter(w => w.length > 0)
    if (words.length === 0) return MIN_COLUMN_WIDTH
    return Math.max(...words.map(w => stringWidth(w)), MIN_COLUMN_WIDTH)
  }

  const getIdealWidth = (cell: { text: string } | undefined): number =>
    Math.max(stringWidth(getPlainText(cell)), MIN_COLUMN_WIDTH)

  // Step 1: minimum (longest word) and ideal (full content) widths.
  const minWidths = token.header.map((header, colIndex) => {
    let maxMinWidth = getMinWidth(header)
    for (const row of token.rows) {
      maxMinWidth = Math.max(maxMinWidth, getMinWidth(row[colIndex]))
    }
    return maxMinWidth
  })
  const idealWidths = token.header.map((header, colIndex) => {
    let maxIdeal = getIdealWidth(header)
    for (const row of token.rows) {
      maxIdeal = Math.max(maxIdeal, getIdealWidth(row[colIndex]))
    }
    return maxIdeal
  })

  // Step 2: available space.
  const numCols = token.header.length
  const borderOverhead = 1 + numCols * 3 // │ + (2 padding + 1 border) per col
  const availableWidth = Math.max(
    terminalWidth - borderOverhead - SAFETY_MARGIN,
    numCols * MIN_COLUMN_WIDTH,
  )

  // Step 3: column widths that fit.
  const totalMin = minWidths.reduce((sum, w) => sum + w, 0)
  const totalIdeal = idealWidths.reduce((sum, w) => sum + w, 0)
  let needsHardWrap = false
  let columnWidths: number[]
  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths
  } else if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin
    const overflows = idealWidths.map((ideal, i) => ideal - minWidths[i]!)
    const totalOverflow = overflows.reduce((sum, o) => sum + o, 0)
    columnWidths = minWidths.map((min, i) => {
      if (totalOverflow === 0) return min
      const extra = Math.floor((overflows[i]! / totalOverflow) * extraSpace)
      return min + extra
    })
  } else {
    needsHardWrap = true
    const scaleFactor = availableWidth / totalMin
    columnWidths = minWidths.map(w =>
      Math.max(Math.floor(w * scaleFactor), MIN_COLUMN_WIDTH),
    )
  }

  // Step 4: max wrapped row lines — drives format decision.
  function calculateMaxRowLines(): number {
    let maxLines = 1
    for (let i = 0; i < token.header.length; i++) {
      const content = formatCell(token.header[i])
      const wrapped = wrapText(content, columnWidths[i]!, {
        hard: needsHardWrap,
      })
      maxLines = Math.max(maxLines, wrapped.length)
    }
    for (const row of token.rows) {
      for (let i = 0; i < row.length; i++) {
        const content = formatCell(row[i])
        const wrapped = wrapText(content, columnWidths[i]!, {
          hard: needsHardWrap,
        })
        maxLines = Math.max(maxLines, wrapped.length)
      }
    }
    return maxLines
  }

  const maxRowLines = calculateMaxRowLines()
  const useVerticalFormat = maxRowLines > MAX_ROW_LINES

  function renderRowLines(
    cells: ReadonlyArray<{ text: string } | undefined>,
    isHeader: boolean,
  ): string[] {
    const cellLines = cells.map((cell, colIndex) => {
      const formatted = formatCell(cell)
      const width = columnWidths[colIndex]!
      return wrapText(formatted, width, { hard: needsHardWrap })
    })

    const maxLines = Math.max(...cellLines.map(l => l.length), 1)
    const verticalOffsets = cellLines.map(l =>
      Math.floor((maxLines - l.length) / 2),
    )

    const result: string[] = []
    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let line = '│'
      for (let colIndex = 0; colIndex < cells.length; colIndex++) {
        const lines = cellLines[colIndex]!
        const offset = verticalOffsets[colIndex]!
        const contentLineIdx = lineIdx - offset
        const lineText =
          contentLineIdx >= 0 && contentLineIdx < lines.length
            ? lines[contentLineIdx]!
            : ''
        const width = columnWidths[colIndex]!
        const align: CellAlign = isHeader
          ? 'center'
          : (token.align?.[colIndex] ?? 'left')
        line +=
          ' ' +
          padAligned(lineText, stringWidth(stripAnsi(lineText)), width, align) +
          ' │'
      }
      result.push(line)
    }
    return result
  }

  function renderBorderLine(type: 'top' | 'middle' | 'bottom'): string {
    const [left, mid, cross, right] = {
      top: ['┌', '─', '┬', '┐'],
      middle: ['├', '─', '┼', '┤'],
      bottom: ['└', '─', '┴', '┘'],
    }[type] as [string, string, string, string]
    let line = left
    columnWidths.forEach((width, colIndex) => {
      line += mid.repeat(width + 2)
      line += colIndex < columnWidths.length - 1 ? cross : right
    })
    return line
  }

  // Vertical (key-value) format for very narrow terminals.
  function renderVerticalFormat(): string {
    const lines: string[] = []
    const headers = token.header.map(h => getPlainText(h))
    const separatorWidth = Math.min(terminalWidth - 1, 40)
    const separator = '─'.repeat(separatorWidth)
    const wrapIndent = '  '
    token.rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) lines.push(separator)
      row.forEach((cell, colIndex) => {
        const label = headers[colIndex] || `Column ${colIndex + 1}`
        const rawValue = formatCell(cell).trimEnd()
        const value = rawValue.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()

        const firstLineWidth = terminalWidth - stringWidth(label) - 3
        const subsequentLineWidth = terminalWidth - wrapIndent.length - 1

        const firstPassLines = wrapText(value, Math.max(firstLineWidth, 10))
        const firstLine = firstPassLines[0] || ''
        let wrappedValue: string[]
        if (
          firstPassLines.length <= 1 ||
          subsequentLineWidth <= firstLineWidth
        ) {
          wrappedValue = firstPassLines
        } else {
          const remaining = firstPassLines
            .slice(1)
            .map(l => l.trim())
            .join(' ')
          const rewrapped = wrapText(remaining, subsequentLineWidth)
          wrappedValue = [firstLine, ...rewrapped]
        }

        lines.push(
          `${ANSI_BOLD_START}${label}:${ANSI_BOLD_END} ${wrappedValue[0] || ''}`,
        )
        for (let i = 1; i < wrappedValue.length; i++) {
          const line = wrappedValue[i]!
          if (!line.trim()) continue
          lines.push(`${wrapIndent}${line}`)
        }
      })
    })
    return lines.join('\n')
  }

  if (useVerticalFormat) {
    return <Ansi>{renderVerticalFormat()}</Ansi>
  }

  const tableLines: string[] = []
  tableLines.push(renderBorderLine('top'))
  tableLines.push(...renderRowLines(token.header, true))
  tableLines.push(renderBorderLine('middle'))
  token.rows.forEach((row, rowIndex) => {
    tableLines.push(...renderRowLines(row, false))
    if (rowIndex < token.rows.length - 1) {
      tableLines.push(renderBorderLine('middle'))
    }
  })
  tableLines.push(renderBorderLine('bottom'))

  // Safety check for terminal-resize races: if any line exceeds terminal
  // width, fall back to vertical format.
  const maxLineWidth = Math.max(
    ...tableLines.map(line => stringWidth(stripAnsi(line))),
  )
  if (maxLineWidth > terminalWidth - SAFETY_MARGIN) {
    return <Ansi>{renderVerticalFormat()}</Ansi>
  }

  return <Ansi>{tableLines.join('\n')}</Ansi>
}
