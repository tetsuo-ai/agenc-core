import { type ColorType, colorize } from '../ink/colorize.js'
import type { Color } from '../ink/styles.js'
import type { Theme } from '../theme.js'

/**
 * Theme-aware color function. Resolves AgenC theme keys (`'primary'`,
 * `'accent'`, `'error'`, …) to raw color values before delegating to
 * the ink renderer's colorize. Raw color literals (`rgb(...)`, `#hex`,
 * `ansi256(...)`, `ansi:...`) bypass theme lookup.
 */
export function color(
  c: keyof Theme['colors'] | Color | undefined,
  theme: Theme,
  type: ColorType = 'foreground',
): (text: string) => string {
  return text => {
    if (!c) {
      return text
    }
    // Raw color values bypass theme lookup
    if (
      c.startsWith('rgb(') ||
      c.startsWith('#') ||
      c.startsWith('ansi256(') ||
      c.startsWith('ansi:')
    ) {
      return colorize(text, c as Color, type)
    }
    // Theme key lookup
    return colorize(text, theme.colors[c as keyof Theme['colors']], type)
  }
}
