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
    return wrapAnsi(text, maxWidth, {
      trim: true,
      hard: true,
    })
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
