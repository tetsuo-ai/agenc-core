import React, { type ReactNode } from 'react'
import Box from '../ink/components/Box.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import type { Theme } from '../theme.js'
import { glyphs } from './glyphs.js'
import ThemedText from './ThemedText.js'

type ListItemProps = {
  /**
   * Whether this item is currently focused (keyboard selection).
   * Shows the pointer indicator (❯) when true.
   */
  isFocused: boolean
  /**
   * Whether this item is selected (chosen/checked).
   * Shows the checkmark indicator (✓) when true.
   * @default false
   */
  isSelected?: boolean
  /**
   * The content to display for this item.
   */
  children: ReactNode
  /**
   * Optional description text displayed below the main content.
   */
  description?: string
  /**
   * Show a down arrow indicator instead of pointer (for scroll hints).
   * Only applies when not focused.
   */
  showScrollDown?: boolean
  /**
   * Show an up arrow indicator instead of pointer (for scroll hints).
   * Only applies when not focused.
   */
  showScrollUp?: boolean
  /**
   * Whether to apply automatic styling to the children based on
   * focus/selection state.
   * - When true (default): children are wrapped in ThemedText with
   *   state-based colors.
   * - When false: children are rendered as-is, allowing custom styling.
   * @default true
   */
  styled?: boolean
  /**
   * Whether this item is disabled. Disabled items show dimmed text and
   * no indicators.
   * @default false
   */
  disabled?: boolean
  /**
   * Whether this ListItem should declare the terminal cursor position.
   * Set false when a child (e.g. text input) declares its own cursor.
   * @default true
   */
  declareCursor?: boolean
}

/**
 * A list item component for selection UIs (dropdowns, multi-selects,
 * menus). Handles the common pattern of:
 * - Pointer indicator (❯) for focused items
 * - Checkmark indicator (✓) for selected items
 * - Scroll indicators (↓↑) for truncated lists
 * - Color states for focus/selection
 *
 * Color mapping (cyberpunk palette):
 * - focused → `accent` (fuchsia)
 * - selected → `success` (frost violet)
 * - disabled → `dim` (deep slate)
 *
 * @example
 * {options.map((option, i) => (
 *   <ListItem
 *     key={option.id}
 *     isFocused={focusIndex === i}
 *     isSelected={selectedId === option.id}
 *   >
 *     {option.label}
 *   </ListItem>
 * ))}
 */
export function ListItem({
  isFocused,
  isSelected = false,
  children,
  description,
  showScrollDown,
  showScrollUp,
  styled = true,
  disabled = false,
  declareCursor,
}: ListItemProps) {
  function renderIndicator() {
    if (disabled) return <ThemedText> </ThemedText>
    if (isFocused)
      return <ThemedText color="accent">{glyphs.pointer}</ThemedText>
    if (showScrollDown)
      return <ThemedText dimColor={true}>{glyphs.arrowDown}</ThemedText>
    if (showScrollUp)
      return <ThemedText dimColor={true}>{glyphs.arrowUp}</ThemedText>
    return <ThemedText> </ThemedText>
  }

  function getTextColor(): keyof Theme['colors'] | undefined {
    if (disabled) return 'dim'
    if (!styled) return undefined
    if (isSelected) return 'success'
    if (isFocused) return 'accent'
    return undefined
  }

  const textColor = getTextColor()
  const cursorActive = isFocused && !disabled && declareCursor !== false
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: cursorActive,
  })

  const indicator = renderIndicator()
  const content = styled ? (
    <ThemedText color={textColor} dimColor={disabled}>
      {children}
    </ThemedText>
  ) : (
    children
  )
  const checkmark = isSelected && !disabled && (
    <ThemedText color="success">{glyphs.tick}</ThemedText>
  )

  return (
    <Box ref={cursorRef} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {indicator}
        {content}
        {checkmark}
      </Box>
      {description && (
        <Box paddingLeft={2}>
          <ThemedText color="dim">{description}</ThemedText>
        </Box>
      )}
    </Box>
  )
}
