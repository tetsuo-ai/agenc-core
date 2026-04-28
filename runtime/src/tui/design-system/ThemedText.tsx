import React, { type ReactNode, useContext } from 'react'
import Text from '../ink/components/Text.js'
import type { Color, Styles } from '../ink/styles.js'
import type { Theme } from '../theme.js'
import { useTheme } from './ThemeProvider.js'

type ThemeColorKey = keyof Theme['colors']

/**
 * Colors uncolored ThemedText in the subtree. Precedence:
 * explicit `color` > this > dimColor. Crosses Box boundaries
 * (Ink's style cascade doesn't).
 */
export const TextHoverColorContext = React.createContext<
  ThemeColorKey | undefined
>(undefined)

export type Props = {
  /**
   * Change text color. Accepts a theme key or raw color value.
   */
  readonly color?: ThemeColorKey | Color

  /**
   * Same as `color`, but for background. Must be a theme key.
   */
  readonly backgroundColor?: ThemeColorKey

  /**
   * Dim the color using the theme's `dim` color.
   * This is compatible with bold (unlike ANSI dim).
   */
  readonly dimColor?: boolean

  /**
   * Make the text bold.
   */
  readonly bold?: boolean

  /**
   * Make the text italic.
   */
  readonly italic?: boolean

  /**
   * Make the text underlined.
   */
  readonly underline?: boolean

  /**
   * Make the text crossed with a line.
   */
  readonly strikethrough?: boolean

  /**
   * Inverse background and foreground colors.
   */
  readonly inverse?: boolean

  /**
   * Wrap or truncate text wider than the container. Defaults to `wrap`.
   */
  readonly wrap?: Styles['textWrap']
  readonly children?: ReactNode
}

function resolveColor(
  color: ThemeColorKey | Color | undefined,
  theme: Theme,
): Color | undefined {
  if (!color) return undefined
  if (
    color.startsWith('rgb(') ||
    color.startsWith('#') ||
    color.startsWith('ansi256(') ||
    color.startsWith('ansi:')
  ) {
    return color as Color
  }
  return theme.colors[color as ThemeColorKey] as Color
}

/**
 * Theme-aware Text component that resolves AgenC theme color keys
 * (`'primary'`, `'accent'`, `'error'`, …) to raw color values.
 * `dimColor` maps to the theme's `dim` color (cool deep slate in
 * the cyberpunk palette) so dim text stays in-family.
 */
export default function ThemedText({
  color,
  backgroundColor,
  dimColor = false,
  bold = false,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = 'wrap',
  children,
}: Props) {
  const theme = useTheme()
  const hoverColor = useContext(TextHoverColorContext)
  const resolvedColor =
    !color && hoverColor
      ? resolveColor(hoverColor, theme)
      : dimColor
      ? (theme.colors.dim as Color)
      : resolveColor(color, theme)
  const resolvedBackgroundColor = backgroundColor
    ? (theme.colors[backgroundColor] as Color)
    : undefined
  return (
    <Text
      color={resolvedColor}
      backgroundColor={resolvedBackgroundColor}
      bold={bold}
      italic={italic}
      underline={underline}
      strikethrough={strikethrough}
      inverse={inverse}
      wrap={wrap}
    >
      {children}
    </Text>
  )
}
