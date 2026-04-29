/**
 * Centralized unicode glyphs used across the AgenC design system.
 *
 * Inlined to avoid the `figures` npm dependency. Win32 conhost has historic
 * issues with some of these (notably ✓/✗); on Windows we substitute the
 * ASCII fallbacks the upstream `figures` package uses.
 */

const isWindows =
  typeof process !== 'undefined' && process.platform === 'win32'

export const glyphs = isWindows
  ? {
      tick: '√',
      cross: '×',
      warning: '‼',
      info: 'i',
      circle: '( )',
      pointer: '>',
      arrowUp: '↑',
      arrowDown: '↓',
    }
  : {
      tick: '✓',
      cross: '✗',
      warning: '⚠',
      info: 'ℹ',
      circle: '◯',
      pointer: '❯',
      arrowUp: '↑',
      arrowDown: '↓',
    }
