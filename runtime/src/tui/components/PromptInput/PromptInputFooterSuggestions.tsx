import { memo, type ReactNode } from 'react'
import { selectAgenCTuiGlyphs } from '../../glyphs.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { truncatePathMiddle, truncateToWidth } from '../../../utils/format.js'
import type { Theme } from '../../../utils/theme.js'
import { PROMPT_BAND_MARGIN_X, PROMPT_BAND_PADDING_X } from './utils.js'

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
  enterAction?: 'run' | 'complete'
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

/** Most rows the list shows at once. The window follows the selection. */
const MAX_VISIBLE_ROWS = 6

/**
 * Fill behind the selected row: a muted gray from the theme's own scale. It
 * stays well below the ink, so the row reads as highlighted rather than
 * inverted, and it is one clear step away from both the terminal surface and
 * the prompt band right above the list (promptBackground), so the first row
 * never reads as part of the prompt. Light, dark and olive each define it.
 */
const SELECTED_ROW_BACKGROUND: keyof Theme = 'muted3'

/** The marker cell and the space after it, as wide as the prompt glyph. */
const MARKER_COLUMNS = 2

/** Columns between the end of the widest name and its description. */
const NAME_GAP_COLUMNS = 2

/**
 * Width the list takes from the given columns. Its edges line up with the
 * prompt band (PROMPT_BAND_MARGIN_X on each side), so the selected row's fill
 * spans exactly as wide as the prompt above it.
 */
export function getSuggestionListWidth(columns: number): number {
  return Math.max(1, Math.floor(columns) - 2 * PROMPT_BAND_MARGIN_X)
}

/** Truncate to a column budget; an empty budget gives an empty string. */
function fitToWidth(text: string, width: number): string {
  return width <= 0 ? '' : truncateToWidth(text, width)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ')
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

/**
 * One row as two strings: the name part (padded to the name column) and the
 * description part. Their widths add up to at most `width`.
 */
function getRowParts(
  item: SuggestionItem,
  nameColumnWidth: number,
  width: number,
  mcpResourceGlyph: string,
): { name: string; description: string } {
  if (isUnifiedSuggestion(item.id)) {
    // Files, MCP resources and agents keep their icon and a " - " separator.
    const icon = getIcon(item.id, mcpResourceGlyph)
    const description = item.description ? oneLine(item.description) : ''
    let displayText = item.displayText
    if (item.id.startsWith('file-')) {
      const descriptionReserve = description
        ? Math.min(20, stringWidth(description)) + 3
        : 0
      displayText = truncatePathMiddle(
        displayText,
        Math.max(1, width - 2 - descriptionReserve),
      )
    } else if (item.id.startsWith('mcp-resource-')) {
      displayText = truncateToWidth(displayText, 30)
    }
    const name = fitToWidth(`${icon} ${displayText}`, width)
    const rest = width - stringWidth(name)
    return {
      name,
      description: description && rest > 3
        ? ` - ${fitToWidth(description, rest - 3)}`
        : '',
    }
  }

  const nameWidth = Math.min(nameColumnWidth, width)
  const name = fitToWidth(item.displayText, nameWidth - NAME_GAP_COLUMNS)
  const paddedName = name + ' '.repeat(Math.max(0, nameWidth - stringWidth(name)))
  const tag = item.tag ? `[${item.tag}] ` : ''
  const description = item.description ? oneLine(item.description) : ''
  return {
    name: paddedName,
    description: fitToWidth(`${tag}${description}`, width - nameWidth),
  }
}

const SuggestionItemRow = memo(function SuggestionItemRow({
  item,
  nameColumnWidth,
  isSelected,
  width,
}: {
  item: SuggestionItem
  nameColumnWidth: number
  isSelected: boolean
  width: number
}): ReactNode {
  const glyphs = selectAgenCTuiGlyphs()
  const marker = isSelected ? glyphs.pointerSmall : ' '
  const parts = getRowParts(
    item,
    nameColumnWidth,
    Math.max(0, width - MARKER_COLUMNS),
    glyphs.mcpResource,
  )
  // Selected: the marker and name in full ink and bold, the description in
  // the normal tone, all on the muted fill. Other rows: the name in the normal
  // tone, the description dimmed.
  return (
    <Box
      width="100%"
      paddingX={PROMPT_BAND_PADDING_X}
      backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
    >
      <Text wrap="truncate">
        <Text color="text" bold={isSelected}>
          {`${marker} `}
        </Text>
        <Text color={item.color ?? 'text'} bold={isSelected}>
          {parts.name}
        </Text>
        {parts.description ? (
          <Text
            color={isSelected ? 'text' : undefined}
            dimColor={!isSelected}
          >
            {parts.description}
          </Text>
        ) : null}
      </Text>
    </Box>
  )
})

type Props = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  maxColumnWidth?: number
  availableColumns?: number
  /**
   * Rows the caller can give the list (fullscreen passes what the layout
   * leaves under the prompt). When absent, the terminal height bounds it.
   */
  availableRows?: number
}

/**
 * The suggestion list under the prompt: one row per match, no frame, title,
 * count or key hints. The selected row carries the marker and a muted fill;
 * the window scrolls with the selection.
 */
export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth,
  availableColumns,
  availableRows,
}: Props): ReactNode {
  const { rows, columns } = useTerminalSize()
  const rowBudget =
    availableRows === undefined
      ? Math.max(1, rows - 3)
      : Number.isFinite(availableRows)
        ? Math.max(0, Math.floor(availableRows))
        : 0
  const maxVisibleItems = Math.min(MAX_VISIBLE_ROWS, rowBudget)
  if (suggestions.length === 0 || maxVisibleItems === 0) {
    return null
  }

  const start = Math.max(
    0,
    Math.min(
      selectedSuggestion - Math.floor(maxVisibleItems / 2),
      suggestions.length - maxVisibleItems,
    ),
  )
  const visibleItems = suggestions.slice(start, start + maxVisibleItems)
  const selectedId = suggestions[selectedSuggestion]?.id

  const listWidth = getSuggestionListWidth(availableColumns ?? columns)
  const rowWidth = Math.max(1, listWidth - 2 * PROMPT_BAND_PADDING_X)
  // The name column is as wide as the longest visible name plus a gap, so it
  // tracks the rows on screen. It never takes more than 45% of the row.
  const nameColumnWidth = Math.max(
    1,
    Math.min(
      maxColumnWidth ?? Number.POSITIVE_INFINITY,
      Math.max(...visibleItems.map(item => stringWidth(item.displayText))) +
        NAME_GAP_COLUMNS,
      Math.floor(rowWidth * 0.45),
    ),
  )

  return (
    <Box
      flexDirection="column"
      width={listWidth}
      marginX={PROMPT_BAND_MARGIN_X}
      opaque={true}
    >
      {visibleItems.map(item => {
        const isSelected = item.id === selectedId
        return (
          <SuggestionItemRow
            key={suggestionRowKey(item, isSelected)}
            item={item}
            nameColumnWidth={nameColumnWidth}
            isSelected={isSelected}
            width={rowWidth}
          />
        )
      })}
    </Box>
  )
}

export default memo(PromptInputFooterSuggestions)
