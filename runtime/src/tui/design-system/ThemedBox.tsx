import React, { type PropsWithChildren } from 'react'
import Box from '../ink/components/Box.js'
import type { DOMElement } from '../ink/dom.js'
import type { ClickEvent } from '../ink/events/click-event.js'
import type { FocusEvent } from '../ink/events/focus-event.js'
import type { KeyboardEvent } from '../ink/events/keyboard-event.js'
import type { Color, Styles } from '../ink/styles.js'
import type { Theme } from '../theme.js'
import { useTheme } from './ThemeProvider.js'

type ThemeColorKey = keyof Theme['colors']

// Color props that accept theme keys
type ThemedColorProps = {
  readonly borderColor?: ThemeColorKey | Color
  readonly borderTopColor?: ThemeColorKey | Color
  readonly borderBottomColor?: ThemeColorKey | Color
  readonly borderLeftColor?: ThemeColorKey | Color
  readonly borderRightColor?: ThemeColorKey | Color
  readonly backgroundColor?: ThemeColorKey | Color
}

// Base Styles without color props (they'll be overridden)
type BaseStylesWithoutColors = Omit<
  Styles,
  | 'textWrap'
  | 'borderColor'
  | 'borderTopColor'
  | 'borderBottomColor'
  | 'borderLeftColor'
  | 'borderRightColor'
  | 'backgroundColor'
>
export type Props = BaseStylesWithoutColors &
  ThemedColorProps & {
    tabIndex?: number
    autoFocus?: boolean
    onClick?: (event: ClickEvent) => void
    onFocus?: (event: FocusEvent) => void
    onFocusCapture?: (event: FocusEvent) => void
    onBlur?: (event: FocusEvent) => void
    onBlurCapture?: (event: FocusEvent) => void
    onKeyDown?: (event: KeyboardEvent) => void
    onKeyDownCapture?: (event: KeyboardEvent) => void
    onMouseEnter?: () => void
    onMouseLeave?: () => void
  }

/**
 * Resolves a color value that may be a theme key to a raw Color.
 */
function resolveColor(
  color: ThemeColorKey | Color | undefined,
  theme: Theme,
): Color | undefined {
  if (!color) return undefined
  // Raw color literals bypass theme lookup
  if (
    color.startsWith('rgb(') ||
    color.startsWith('#') ||
    color.startsWith('ansi256(') ||
    color.startsWith('ansi:')
  ) {
    return color as Color
  }
  // Theme key lookup
  return theme.colors[color as ThemeColorKey] as Color
}

/**
 * Theme-aware Box component that resolves AgenC theme color keys
 * (`'primary'`, `'accent'`, `'error'`, …) to raw color values.
 * Wraps the base Ink Box for border/background color resolution.
 */
function ThemedBoxInner(
  {
    borderColor,
    borderTopColor,
    borderBottomColor,
    borderLeftColor,
    borderRightColor,
    backgroundColor,
    children,
    ...rest
  }: PropsWithChildren<Props>,
  ref: React.ForwardedRef<DOMElement>,
) {
  const theme = useTheme()
  const resolvedBorderColor = resolveColor(borderColor, theme)
  const resolvedBorderTopColor = resolveColor(borderTopColor, theme)
  const resolvedBorderBottomColor = resolveColor(borderBottomColor, theme)
  const resolvedBorderLeftColor = resolveColor(borderLeftColor, theme)
  const resolvedBorderRightColor = resolveColor(borderRightColor, theme)
  const resolvedBackgroundColor = resolveColor(backgroundColor, theme)
  return (
    <Box
      ref={ref}
      borderColor={resolvedBorderColor}
      borderTopColor={resolvedBorderTopColor}
      borderBottomColor={resolvedBorderBottomColor}
      borderLeftColor={resolvedBorderLeftColor}
      borderRightColor={resolvedBorderRightColor}
      backgroundColor={resolvedBackgroundColor}
      {...rest}
    >
      {children}
    </Box>
  )
}
const ThemedBox = React.forwardRef<DOMElement, PropsWithChildren<Props>>(
  ThemedBoxInner,
)
ThemedBox.displayName = 'ThemedBox'
export default ThemedBox
