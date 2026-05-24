import type { Color } from '../../ink/styles.js'
import type { Theme } from '../../../utils/theme.js'

export type LegacyColorName = 'gray' | 'grey'
export type ThemedColor = keyof Theme | Color | LegacyColorName

const LEGACY_COLOR_ALIASES: Record<LegacyColorName, keyof Theme> = {
  gray: 'inactive',
  grey: 'inactive',
}

function isRawColor(color: string): color is Color {
  return (
    color.startsWith('rgb(') ||
    color.startsWith('#') ||
    color.startsWith('ansi256(') ||
    color.startsWith('ansi:')
  )
}

function isThemeKey(color: string, theme: Theme): color is keyof Theme {
  return Object.prototype.hasOwnProperty.call(theme, color)
}

export function resolveThemedColor(
  color: ThemedColor | undefined,
  theme: Theme,
): Color | undefined {
  if (!color) return undefined
  if (isRawColor(color)) return color
  if (isThemeKey(color, theme)) return theme[color] as Color

  const alias = LEGACY_COLOR_ALIASES[color as LegacyColorName]
  return alias ? (theme[alias] as Color) : undefined
}
