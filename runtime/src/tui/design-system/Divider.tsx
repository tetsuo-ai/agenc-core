import React from 'react'
import { Ansi } from '../ink/Ansi.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { Theme } from '../theme.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import ThemedText from './ThemedText.js'

type DividerProps = {
  /** Width of the divider in characters. Defaults to terminal width. */
  width?: number
  /** Theme color for the divider. If not provided, dimColor is used. */
  color?: keyof Theme['colors']
  /** Character to use for the divider line. @default '─' */
  char?: string
  /** Padding to subtract from the width (e.g., for indentation). @default 0 */
  padding?: number
  /** Title shown in the middle of the divider. May contain ANSI codes. */
  title?: string
}

/**
 * A horizontal divider line.
 *
 * @example
 * // Full-width dimmed divider
 * <Divider />
 *
 * @example
 * // Colored divider
 * <Divider color="accent" />
 *
 * @example
 * // Fixed width
 * <Divider width={40} />
 *
 * @example
 * // Full width minus padding (for indented content)
 * <Divider padding={4} />
 *
 * @example
 * // With centered title
 * <Divider title="3 new messages" />
 */
export function Divider({
  width,
  color,
  char = '─',
  padding = 0,
  title,
}: DividerProps) {
  const { columns: terminalWidth } = useTerminalSize()
  const effectiveWidth = Math.max(0, (width ?? terminalWidth) - padding)
  if (title) {
    const titleWidth = stringWidth(title) + 2
    const sideWidth = Math.max(0, effectiveWidth - titleWidth)
    const leftWidth = Math.floor(sideWidth / 2)
    const rightWidth = sideWidth - leftWidth
    return (
      <ThemedText color={color} dimColor={!color}>
        {char.repeat(leftWidth)}{' '}
        <ThemedText dimColor={true}>
          <Ansi>{title}</Ansi>
        </ThemedText>{' '}
        {char.repeat(rightWidth)}
      </ThemedText>
    )
  }
  return (
    <ThemedText color={color} dimColor={!color}>
      {char.repeat(effectiveWidth)}
    </ThemedText>
  )
}
