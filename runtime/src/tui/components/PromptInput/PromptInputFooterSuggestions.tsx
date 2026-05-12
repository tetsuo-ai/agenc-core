import figures from 'figures'
import { memo, type ReactNode } from 'react'
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

const SELECTED_PREFIX = `${figures.pointer} `
const UNSELECTED_PREFIX = '  '
const PREFIX_WIDTH = stringWidth(SELECTED_PREFIX)

function getIcon(itemId: string): string {
  if (itemId.startsWith('file-')) return '+'
  if (itemId.startsWith('mcp-resource-')) return '◇'
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
}: {
  item: SuggestionItem
  maxColumnWidth?: number
  isSelected: boolean
}): ReactNode {
  const columns = useTerminalSize().columns
  const selectionPrefix = isSelected ? SELECTED_PREFIX : UNSELECTED_PREFIX
  const rowBackgroundColor: keyof Theme | undefined = isSelected
    ? 'userMessageBackground'
    : undefined
  const textColor: keyof Theme | undefined = isSelected
    ? 'text'
    : item.color
  // Every row is one line. The expanded second-line description was
  // dropped after it kept reading as a duplicate of the inline
  // description and made the selected row taller than its neighbours.

  let lineContent: string
  if (isUnifiedSuggestion(item.id)) {
    const icon = getIcon(item.id)
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
      const maxPathLength =
        columns -
        PREFIX_WIDTH -
        iconWidth -
        paddingWidth -
        separatorWidth -
        descReserve
      displayText = truncatePathMiddle(item.displayText, maxPathLength)
    } else if (isMcpResource) {
      displayText = truncateToWidth(item.displayText, 30)
    } else {
      displayText = item.displayText
    }

    const availableWidth =
      columns -
      PREFIX_WIDTH -
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
    const maxNameWidth = Math.floor(columns * 0.4)
    const displayTextWidth = Math.min(
      maxColumnWidth ?? stringWidth(item.displayText) + 5,
      maxNameWidth,
    )

    let displayText = item.displayText
    if (stringWidth(displayText) > displayTextWidth - 2) {
      displayText = truncateToWidth(displayText, displayTextWidth - 2)
    }

    const paddedDisplayText =
      selectionPrefix +
      displayText +
      ' '.repeat(Math.max(0, displayTextWidth - stringWidth(displayText)))
    const tagText = item.tag ? `[${item.tag}] ` : ''
    const tagWidth = stringWidth(tagText)
    const descriptionWidth = Math.max(
      0,
      columns - PREFIX_WIDTH - displayTextWidth - tagWidth - 4,
    )
    const truncatedDescription = item.description
      ? truncateToWidth(item.description.replace(/\s+/g, ' '), descriptionWidth)
      : ''
    lineContent = `${paddedDisplayText}${tagText}${truncatedDescription}`
  }

  return (
    <Box width="100%" opaque={true} backgroundColor={rowBackgroundColor}>
      <Text
        color={textColor}
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
}

export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth: maxColumnWidthProp,
  overlay,
}: Props): ReactNode {
  const { rows, columns } = useTerminalSize()
  const maxVisibleItems = overlay ? OVERLAY_MAX_ITEMS : Math.min(6, Math.max(1, rows - 3))

  if (suggestions.length === 0) {
    return null
  }

  const maxColumnWidth =
    maxColumnWidthProp ??
    Math.max(...suggestions.map(item => stringWidth(item.displayText))) + 5

  const startIndex = Math.max(
    0,
    Math.min(
      selectedSuggestion - Math.floor(maxVisibleItems / 2),
      suggestions.length - maxVisibleItems,
    ),
  )
  const endIndex = Math.min(startIndex + maxVisibleItems, suggestions.length)
  const visibleItems = suggestions.slice(startIndex, endIndex)
  // Round-2 MD-NEW8: when the suggestion list is longer than the
  // visible window (e.g. tab-completing inside a directory with 200
  // entries), show the count of items hidden below the fold so the
  // user knows there's more to scroll through. Without this the 5
  // visible rows look identical to a 5-entry directory.
  const hiddenAfter = suggestions.length - endIndex
  const hiddenBefore = startIndex

  const width = Math.max(32, columns - 4)
  const headerHint = suggestions.length === 1
    ? '1 match'
    : `${suggestions.length} matches`

  return (
    <Box
      flexDirection="column"
      justifyContent={overlay ? undefined : 'flex-end'}
      width={width}
      marginX={1}
      borderStyle="round"
      borderColor="promptBorder"
      paddingX={1}
      backgroundColor="clawd_background"
    >
      <Box justifyContent="space-between" width="100%">
        <Text color="inactive" bold>
          SLASH COMMANDS
        </Text>
        <Text color="inactive">{headerHint}</Text>
      </Box>
      <Box justifyContent="space-between" width="100%">
        <Text color="promptBorder">command</Text>
        <Text color="inactive">navigate ↑↓ · run ↵</Text>
      </Box>
      {hiddenBefore > 0 ? (
        <Box>
          <Text dimColor>↑ {hiddenBefore} more above</Text>
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
              maxColumnWidth={maxColumnWidth}
              isSelected={isSelected}
            />
            {isSelected && item.description ? (
              <Box paddingLeft={PREFIX_WIDTH + 2}>
                <Text color="inactive" wrap="wrap">
                  {item.description.replace(/\s+/g, ' ')}
                </Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
      {hiddenAfter > 0 ? (
        <Box>
          <Text dimColor>↓ {hiddenAfter} more below</Text>
        </Box>
      ) : null}
      <Text color="inactive">type to filter · esc closes</Text>
    </Box>
  )
}

export default memo(PromptInputFooterSuggestions)
