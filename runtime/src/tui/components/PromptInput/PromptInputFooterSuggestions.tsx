import { memo, type ReactNode } from 'react'
import { selectAgenCTuiGlyphs } from '../../glyphs.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { truncatePathMiddle, truncateToWidth } from '../../../utils/format.js'
import type { Theme } from '../../../utils/theme.js'

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
  label: string
  acceptVerb: string
} {
  switch (type) {
    case 'command':
      return { title: 'SLASH COMMANDS', label: 'command', acceptVerb: 'run' }
    case 'file':
      return { title: 'FILES & RESOURCES', label: 'file', acceptVerb: 'insert' }
    case 'directory':
      return { title: 'DIRECTORIES', label: 'directory', acceptVerb: 'insert' }
    case 'agent':
      return { title: 'AGENTS', label: 'agent', acceptVerb: 'message' }
    case 'shell':
      return { title: 'SHELL COMPLETIONS', label: 'shell', acceptVerb: 'complete' }
    case 'custom-title':
      return { title: 'SESSION TITLES', label: 'session', acceptVerb: 'resume' }
    case 'slack-channel':
      return { title: 'SLACK CHANNELS', label: 'channel', acceptVerb: 'mention' }
    case 'none':
      return { title: 'SUGGESTIONS', label: 'suggestion', acceptVerb: 'select' }
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
  const rowBackgroundColor: keyof Theme = isSelected
    ? 'userMessageBackground'
    : 'surfaceBackground'
  const textColor: keyof Theme | undefined = isSelected
    ? 'text'
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
  suggestionType?: SuggestionType
}

export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth: maxColumnWidthProp,
  overlay,
  suggestionType,
}: Props): ReactNode {
  const { rows, columns } = useTerminalSize()
  const maxVisibleItems = overlay ? OVERLAY_MAX_ITEMS : Math.min(6, Math.max(1, rows - 3))

  if (suggestions.length === 0) {
    return null
  }

  const maxColumnWidth =
    maxColumnWidthProp ??
    Math.max(...suggestions.map(item => stringWidth(item.displayText))) + 2

  const startIndex = Math.max(
    0,
    Math.min(
      selectedSuggestion - Math.floor(maxVisibleItems / 2),
      suggestions.length - maxVisibleItems,
    ),
  )
  const endIndex = Math.min(startIndex + maxVisibleItems, suggestions.length)
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

  const glyphs = selectAgenCTuiGlyphs()
  const width = getSuggestionPopupWidth(columns, overlay)
  const contentWidth = Math.max(1, width - 4)
  const headerCopy = getSuggestionHeaderCopy(suggestionType ?? inferSuggestionType(suggestions))
  const headerHint = suggestions.length === 1
    ? '1 match'
    : `${suggestions.length} matches`
  const titleRow = getRightAlignedRowParts(headerCopy.title, headerHint, contentWidth)
  const commandHintRow = getRightAlignedRowParts(
    headerCopy.label,
    `navigate ${glyphs.arrowUp}${glyphs.arrowDown} ${glyphs.separator} ${headerCopy.acceptVerb} ${glyphs.enter}`,
    contentWidth,
  )

  return (
    <Box
      flexDirection="column"
      justifyContent={overlay ? undefined : 'flex-end'}
      width={width}
      marginX={overlay ? 0 : 1}
      borderStyle="single"
      borderColor="agenc"
      paddingX={1}
      backgroundColor="surfaceBackground"
    >
      <Box
        width="100%"
        opaque={true}
        backgroundColor="surfaceBackground"
      >
        <Text color="inactive" bold>{titleRow.left}</Text>
        <Text color="inactive">{titleRow.gap}{titleRow.right}</Text>
      </Box>
      <Box
        width="100%"
        opaque={true}
        backgroundColor="surfaceBackground"
      >
        <Text color="agenc">{commandHintRow.left}</Text>
        <Text color="inactive">
          {commandHintRow.gap}
          {commandHintRow.right}
        </Text>
      </Box>
      {hiddenBefore > 0 ? (
        <Box width="100%" opaque={true} backgroundColor="surfaceBackground">
          <Text dimColor>{glyphs.arrowUp} {hiddenBefore} more above</Text>
        </Box>
      ) : null}
      {visibleItems.map(item => {
        const isSelected = item.id === suggestions[selectedSuggestion]?.id
        return (
          <Box
            key={`${item.id}:${isSelected ? 'selected' : 'idle'}`}
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
      {hiddenAfter > 0 ? (
        <Box width="100%" opaque={true} backgroundColor="surfaceBackground">
          <Text dimColor>{glyphs.arrowDown} {hiddenAfter} more below</Text>
        </Box>
      ) : null}
      <Box width="100%" opaque={true} backgroundColor="surfaceBackground">
        <Text color="inactive">type to filter {glyphs.separator} esc closes</Text>
      </Box>
    </Box>
  )
}

export default memo(PromptInputFooterSuggestions)
