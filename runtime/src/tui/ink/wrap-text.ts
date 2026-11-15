import stripAnsi from 'strip-ansi'
import sliceAnsi from '../../utils/sliceAnsi.js'
import { stringWidth } from './stringWidth.js'
import type { Styles } from './styles.js'
import { wrapAnsi } from './wrapAnsi.js'
import { selectAgenCTuiGlyphs } from '../glyphs.js'

function getTruncationMarker(): string {
  return selectAgenCTuiGlyphs().ellipsis
}

function getTruncationMarkerForWidth(columns: number): string {
  const marker = getTruncationMarker()
  const markerWidth = stringWidth(marker)
  if (markerWidth <= columns) return marker
  return marker.slice(0, Math.max(0, columns))
}

// sliceAnsi may include a boundary-spanning wide char (e.g. CJK at position
// end-1 with width 2 overshoots by 1). Retry with a tighter bound once.
function sliceFit(text: string, start: number, end: number): string {
  const s = sliceAnsi(text, start, end)
  return stringWidth(s) > end - start ? sliceAnsi(text, start, end - 1) : s
}

function truncate(
  text: string,
  columns: number,
  position: 'start' | 'middle' | 'end',
): string {
  if (columns < 1) return ''
  const ellipsis = getTruncationMarkerForWidth(columns)
  const ellipsisWidth = stringWidth(ellipsis)
  if (ellipsisWidth >= columns) return ellipsis

  const length = stringWidth(text)
  if (length <= columns) return text

  if (position === 'start') {
    return ellipsis + sliceFit(text, length - columns + ellipsisWidth, length)
  }
  if (position === 'middle') {
    const contentColumns = columns - ellipsisWidth
    const leadingColumns = Math.floor(contentColumns / 2)
    const trailingColumns = contentColumns - leadingColumns
    return (
      sliceFit(text, 0, leadingColumns) +
      ellipsis +
      sliceFit(text, length - trailingColumns, length)
    )
  }
  return sliceFit(text, 0, columns - ellipsisWidth) + ellipsis
}

const TAB_INTERVAL = 8

/**
 * A list marker at the start of a line, after any indent: a bullet (-, *, +),
 * a number, a letter or a short roman numeral with a dot or parenthesis, then
 * the spaces after it and an optional task box.
 */
const LIST_MARKER_RE = /^( *)(?:[-*+]|\d{1,9}[.)]|[a-z][.)]|[ivx]{1,4}[.)]) +(?:\[[ xX]\] +)?/

/**
 * Columns from the start of a list line to its text: the rows that continue
 * a wrapped item hang under the text, not under the marker. Zero when the
 * line does not start with a list marker.
 */
export function listItemHangWidth(line: string): number {
  const match = LIST_MARKER_RE.exec(stripAnsi(line))
  return match === null ? 0 : stringWidth(match[0])
}

/**
 * Word wrap that drops the space left over at each wrap point but keeps the
 * indent of every source line. The rows that continue an indented line get
 * the same indent, so a nested list item or a line of code stays in its
 * column. A list item's rows hang under its text, past the marker. A plain
 * trimming wrap would move all of them to column 0.
 */
function wrapTrimKeepingIndent(text: string, maxWidth: number): string {
  return text
    .split('\n')
    .map(line => {
      const hang = listItemHangWidth(line)
      // A very wide marker must still leave half the width for the text.
      if (hang > 0 && hang <= Math.floor(maxWidth / 2) && stringWidth(line) > maxWidth) {
        const head = sliceAnsi(line, 0, hang)
        const rows = wrapAnsi(sliceAnsi(line, hang), maxWidth - hang, { trim: true, hard: true }).split('\n')
        const pad = ' '.repeat(hang)
        return rows.map((row, index) => (index === 0 ? head : pad) + row).join('\n')
      }
      const body = line.trimStart()
      if (body.length === 0 || body.length === line.length) {
        return wrapAnsi(line, maxWidth, { trim: true, hard: true })
      }
      let indentWidth = 0
      for (const char of line.slice(0, line.length - body.length)) {
        indentWidth +=
          char === '\t' ? TAB_INTERVAL - (indentWidth % TAB_INTERVAL) : 1
      }
      // A very deep indent must still leave room for the text.
      const indent = ' '.repeat(Math.min(indentWidth, Math.floor(maxWidth / 2)))
      return wrapAnsi(body, maxWidth - indent.length, { trim: true, hard: true })
        .split('\n')
        .map(row => indent + row)
        .join('\n')
    })
    .join('\n')
}

export default function wrapText(
  text: string,
  maxWidth: number,
  wrapType: Styles['textWrap'],
): string {
  if (wrapType === 'wrap') {
    return wrapAnsi(text, maxWidth, {
      trim: false,
      hard: true,
    })
  }

  if (wrapType === 'wrap-trim') {
    return wrapTrimKeepingIndent(text, maxWidth)
  }

  if (wrapType!.startsWith('truncate')) {
    let position: 'end' | 'middle' | 'start' = 'end'

    if (wrapType === 'truncate-middle') {
      position = 'middle'
    }

    if (wrapType === 'truncate-start') {
      position = 'start'
    }

    return truncate(text, maxWidth, position)
  }

  return text
}
