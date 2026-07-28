import { memo, type ReactNode } from 'react'
import { selectAgenCTuiGlyphs } from '../../glyphs.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { truncatePathMiddle, truncateToWidth } from '../../../utils/format.js'
import type { Theme } from '../../../utils/theme.js'

/**
 * React key for a suggestion row. Keyed by the item's stable id ONLY — folding
 * `isSelected` into the key made React unmount/remount the selected and
 * previously-selected rows on every arrow keypress, defeating the row's `memo`.
 * `isSelected` is passed to the row as a prop instead. The parameter is kept so
 * the key's independence from selection is explicit (and testable).
 */
export function suggestionRowKey(
  item: { readonly id: string },
  isSelected: boolean,
): string {
  void isSelected
  return item.id
}

export type SuggestionItem = {
  id: string
  displayText: string
  tag?: string
  description?: string
  metadata?: unknown
  color?: keyof Theme
}

export type SuggestionType =
  | 'command'
  | 'file'
  | 'directory'
  | 'agent'
  | 'shell'
  | 'custom-title'
  | 'slack-channel'
  | 'none'

export const OVERLAY_MAX_ITEMS = 5

export function getSuggestionPopupWidth(columns: number, overlay?: boolean): number {
  // In overlay (fullscreen/workbench) mode the popup floats directly above the
  // composer box, which spans the full terminal width (width="100%"). The popup
  // therefore takes the full width too — with no horizontal margin — so its
  // border corners line up with the composer's border corners below it. Any
  // inset here makes the popup look misaligned with the composer.
  // Inline mode floats inside a paddingX={2} wrapper, so it stays narrower.
  return overlay ? Math.max(1, columns) : Math.max(1, columns - 10)
}

function padToWidth(text: string, width: number): string {
  const textWidth = stringWidth(text)
  if (textWidth >= width) return text
  return text + ' '.repeat(width - textWidth)
}

function getRightAlignedRowParts(
  left: string,
  right: string,
  width: number,
): { left: string; gap: string; right: string } {
  const safeWidth = Math.max(1, width)
  const truncatedLeft = truncateToWidth(left, safeWidth)
  const leftWidth = stringWidth(truncatedLeft)
  if (leftWidth >= safeWidth) {
    return {
      left: truncatedLeft,
      gap: '',
      right: '',
    }
  }

  const rightWidth = Math.max(0, safeWidth - leftWidth - 1)
  const truncatedRight = truncateToWidth(right, rightWidth)
  const gapWidth = Math.max(
    0,
    safeWidth - leftWidth - stringWidth(truncatedRight),
  )
  return {
    left: truncatedLeft,
    gap: ' '.repeat(gapWidth),
    right: truncatedRight,
  }
}

function getSuggestionHeaderCopy(type: SuggestionType): {
  title: string
  acceptVerb: string
} {
  switch (type) {
    case 'command':
      return { title: 'SLASH COMMANDS', acceptVerb: 'run' }
    case 'file':
      return { title: 'FILES & RESOURCES', acceptVerb: 'insert' }
    case 'directory':
      return { title: 'DIRECTORIES', acceptVerb: 'insert' }
    case 'agent':
      return { title: 'AGENTS', acceptVerb: 'message' }
    case 'shell':
      return { title: 'SHELL COMPLETIONS', acceptVerb: 'complete' }
    case 'custom-title':
      return { title: 'SESSION TITLES', acceptVerb: 'resume' }
    case 'slack-channel':
      return { title: 'SLACK CHANNELS', acceptVerb: 'mention' }
    case 'none':
      return { title: 'SUGGESTIONS', acceptVerb: 'select' }
  }
}

function inferSuggestionType(suggestions: SuggestionItem[]): SuggestionType {
  if (suggestions.every(item => item.id.startsWith('command-') || item.displayText.startsWith('/'))) {
    return 'command'
  }
  if (suggestions.every(item => item.id.startsWith('file-') || item.id.startsWith('mcp-resource-'))) {
    return 'file'
  }
  if (suggestions.every(item => item.id.startsWith('directory-'))) {
    return 'directory'
  }
  if (suggestions.every(item => item.id.startsWith('agent-') || item.id.startsWith('dm-'))) {
    return 'agent'
  }
  return 'none'
}

function getIcon(itemId: string, mcpResourceGlyph: string): string {
  if (itemId.startsWith('file-')) return '+'
  if (itemId.startsWith('mcp-resource-')) return mcpResourceGlyph
  if (itemId.startsWith('agent-')) return '*'
  return '+'
}

function isUnifiedSuggestion(itemId: string): boolean {
  return (
    itemId.startsWith('file-') ||
    itemId.startsWith('mcp-resource-') ||
    itemId.startsWith('agent-')
  )
}

const SuggestionItemRow = memo(function SuggestionItemRow({
  item,
  maxColumnWidth,
  isSelected,
  width,
}: {
  item: SuggestionItem
  maxColumnWidth?: number
  isSelected: boolean
  width: number
}): ReactNode {
  const glyphs = selectAgenCTuiGlyphs()
  const selectedPrefix = `${glyphs.pointer} `
  const prefixWidth = stringWidth(selectedPrefix)
  const selectionPrefix = isSelected ? selectedPrefix : ' '.repeat(prefixWidth)
  const rowBackgroundColor: keyof Theme = isSelected ? 'text' : 'surfaceBackground'
  const textColor: keyof Theme | undefined = isSelected
    ? 'inverseText'
    : item.color
  // Every row is one line. The expanded second-line description was
  // dropped after it kept reading as a duplicate of the inline
  // description and made the selected row taller than its neighbours.

  let lineContent: string
  if (isUnifiedSuggestion(item.id)) {
    const icon = getIcon(item.id, glyphs.mcpResource)
    const isFile = item.id.startsWith('file-')
    const isMcpResource = item.id.startsWith('mcp-resource-')
    const iconWidth = 2
    const paddingWidth = 4
    const separatorWidth = item.description ? 3 : 0

    let displayText: string
    if (isFile) {
      const descReserve = item.description
        ? Math.min(20, stringWidth(item.description))
        : 0
      const maxPathLength = Math.max(
        1,
        width -
        prefixWidth -
        iconWidth -
        paddingWidth -
        separatorWidth -
        descReserve,
      )
      displayText = truncatePathMiddle(item.displayText, maxPathLength)
    } else if (isMcpResource) {
      displayText = truncateToWidth(item.displayText, 30)
    } else {
      displayText = item.displayText
    }

    const availableWidth =
      width -
      prefixWidth -
      iconWidth -
      stringWidth(displayText) -
      separatorWidth -
      paddingWidth

    if (item.description) {
      const truncatedDesc = truncateToWidth(
        item.description.replace(/\s+/g, ' '),
        Math.max(0, availableWidth),
      )
      lineContent = `${selectionPrefix}${icon} ${displayText} - ${truncatedDesc}`
    } else {
      lineContent = `${selectionPrefix}${icon} ${displayText}`
    }
  } else {
    // The name column may take up to 45% of the row; the description owns the
    // rest. The previous 40% cap plus 4 columns of slack starved descriptions
    // ("Install the signed AgenC M…") while the row still had spare width.
    const maxNameWidth = Math.max(1, Math.floor(width * 0.45))
    const displayTextWidth = Math.max(1, Math.min(
      maxColumnWidth ?? stringWidth(item.displayText) + 2,
      maxNameWidth,
    ))

    let displayText = item.displayText
    const displayTextContentWidth = Math.max(0, displayTextWidth - 2)
    if (stringWidth(displayText) > displayTextContentWidth) {
      displayText = truncateToWidth(displayText, displayTextContentWidth)
    }

    const paddedDisplayText =
      selectionPrefix +
      displayText +
      ' '.repeat(Math.max(0, displayTextWidth - stringWidth(displayText)))
    const tagText = item.tag ? `[${item.tag}] ` : ''
    const tagWidth = stringWidth(tagText)
    const descriptionWidth = Math.max(
      0,
      width - prefixWidth - displayTextWidth - tagWidth - 1,
    )
    const truncatedDescription = item.description
      ? truncateToWidth(item.description.replace(/\s+/g, ' '), descriptionWidth)
      : ''
    lineContent = `${paddedDisplayText}${tagText}${truncatedDescription}`
  }

  lineContent = padToWidth(truncateToWidth(lineContent, width), width)

  return (
    <Box width="100%" opaque={true} backgroundColor={rowBackgroundColor}>
      <Text
        color={textColor}
        backgroundColor={rowBackgroundColor}
        dimColor={!isSelected}
        bold={isSelected}
        wrap="truncate"
      >
        {lineContent}
      </Text>
    </Box>
  )
})

type Props = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  maxColumnWidth?: number
  overlay?: boolean
  availableColumns?: number
  availableRows?: number
  suggestionType?: SuggestionType
}

export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth: maxColumnWidthProp,
  overlay,
  availableColumns,
  availableRows,
  suggestionType,
}: Props): ReactNode {
  const { rows, columns } = useTerminalSize()
  const overlayRowBudget =
    overlay && availableRows !== undefined
      ? Number.isFinite(availableRows)
        ? Math.max(0, Math.floor(availableRows))
        : 0
      : null
  const overlayBodyRows =
    overlayRowBudget !== null
      ? Math.max(0, overlayRowBudget - 4)
      : null
  let maxVisibleItems = overlay
    ? Math.min(OVERLAY_MAX_ITEMS, overlayBodyRows ?? OVERLAY_MAX_ITEMS)
    : Math.min(6, Math.max(1, rows - 3))

  // A bordered popup needs four chrome rows (two borders, title, footer) plus
  // at least one result row. If the caller cannot spare five rows, rendering
  // nothing is safer than overflowing and clipping the composer beneath it.
  if (suggestions.length === 0 || overlayBodyRows === 0) {
    return null
  }

  const maxColumnWidth =
    maxColumnWidthProp ??
    Math.max(...suggestions.map(item => stringWidth(item.displayText))) + 2

  const getWindow = (limit: number): { start: number; end: number } => {
    const start = Math.max(
      0,
      Math.min(
        selectedSuggestion - Math.floor(limit / 2),
        suggestions.length - limit,
      ),
    )
    return {
      start,
      end: Math.min(start + limit, suggestions.length),
    }
  }
  let window = getWindow(maxVisibleItems)
  if (overlayBodyRows !== null) {
    while (maxVisibleItems > 1) {
      const markerRows =
        (window.start > 0 ? 1 : 0) +
        (window.end < suggestions.length ? 1 : 0)
      if (maxVisibleItems + markerRows <= overlayBodyRows) break
      maxVisibleItems -= 1
      window = getWindow(maxVisibleItems)
    }
  }
  const startIndex = window.start
  const endIndex = window.end
  const visibleItems = suggestions.slice(startIndex, endIndex)
  // Size the name column to the widest VISIBLE row, not the widest row in the
  // whole result set: one long command anywhere in a 40-entry list was padding
  // every rendered page's name column and starving the descriptions.
  const visibleColumnWidth = Math.min(
    maxColumnWidth,
    Math.max(...visibleItems.map(item => stringWidth(item.displayText))) + 2,
  )
  // Round-2 MD-NEW8: when the suggestion list is longer than the
  // visible window (e.g. tab-completing inside a directory with 200
  // entries), show the count of items hidden below the fold so the
  // user knows there's more to scroll through. Without this the 5
  // visible rows look identical to a 5-entry directory.
  const hiddenAfter = suggestions.length - endIndex
  const hiddenBefore = startIndex
  const overflowRowBudget =
    overlayBodyRows === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, overlayBodyRows - visibleItems.length)
  const showHiddenBefore = hiddenBefore > 0 && overflowRowBudget > 0
  const showHiddenAfter =
    hiddenAfter > 0 &&
    overflowRowBudget > (showHiddenBefore ? 1 : 0)

  const glyphs = selectAgenCTuiGlyphs()
  // Overlay popups live inside a frame in workbench mode. Their parent can be
  // narrower than the terminal, so use that measured width when supplied;
  // sizing to terminal columns pushes the right border outside the viewport.
  const width = getSuggestionPopupWidth(availableColumns ?? columns, overlay)
  const contentWidth = Math.max(1, width - 4)
  const headerCopy = getSuggestionHeaderCopy(suggestionType ?? inferSuggestionType(suggestions))
  const headerHint = suggestions.length === 1
    ? '1 match'
    : `${suggestions.length} matches`
  const titleRow = getRightAlignedRowParts(headerCopy.title, headerHint, contentWidth)
  const primaryFooterHint =
    `${glyphs.arrowUp}${glyphs.arrowDown} navigate ${glyphs.separator} ${glyphs.enter} ${headerCopy.acceptVerb}`
  const extendedFooterHint =
    `${primaryFooterHint} ${glyphs.separator} esc close`
  // Keep the accept action whole on narrow popups. The filter prompt is
  // secondary, so abbreviate it before allowing the key/action pair to be
  // ellipsized (for example, "↵ ru…" taught no usable action at 48 columns).
  const fullFooterLeft = 'type to filter'
  const compactFooterLeft = 'filter'
  const footerLeft =
    stringWidth(fullFooterLeft) + 1 + stringWidth(primaryFooterHint) <= contentWidth
      ? fullFooterLeft
      : compactFooterLeft
  const availableFooterRight = Math.max(
    0,
    contentWidth - stringWidth(footerLeft) - 1,
  )
  const footerHintRow = getRightAlignedRowParts(
    footerLeft,
    stringWidth(extendedFooterHint) <= availableFooterRight
      ? extendedFooterHint
      : primaryFooterHint,
    contentWidth,
  )

  return (
    <Box
      flexDirection="column"
      justifyContent={overlay ? undefined : 'flex-end'}
      width={width}
      marginX={overlay ? 0 : 1}
      borderStyle="single"
      borderColor="text"
      paddingX={1}
      backgroundColor="surfaceBackground"
      opaque={true}
    >
      <Box
        width="100%"
        opaque={true}
        backgroundColor="surfaceBackground"
      >
        <Text color="inactive" bold>{titleRow.left}</Text>
        <Text color="inactive">{titleRow.gap}{titleRow.right}</Text>
      </Box>
      {showHiddenBefore ? (
        <Box width="100%" opaque={true} backgroundColor="surfaceBackground">
          <Text dimColor>{glyphs.arrowUp} {hiddenBefore} more above</Text>
        </Box>
      ) : null}
      {visibleItems.map(item => {
        const isSelected = item.id === suggestions[selectedSuggestion]?.id
        return (
          <Box
            key={suggestionRowKey(item, isSelected)}
            flexDirection="column"
          >
            <SuggestionItemRow
              item={item}
              maxColumnWidth={visibleColumnWidth}
              isSelected={isSelected}
              width={contentWidth}
            />
          </Box>
        )
      })}
      {showHiddenAfter ? (
        <Box width="100%" opaque={true} backgroundColor="surfaceBackground">
          <Text dimColor>{glyphs.arrowDown} {hiddenAfter} more below</Text>
        </Box>
      ) : null}
      <Box width="100%" opaque={true} backgroundColor="surfaceBackground">
        <Text color="inactive">{footerHintRow.left}</Text>
        <Text color="inactive">
          {footerHintRow.gap}
          {footerHintRow.right}
        </Text>
      </Box>
    </Box>
  )
}

export default memo(PromptInputFooterSuggestions)
