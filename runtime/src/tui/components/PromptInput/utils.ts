import type { VimMode } from '../../../types/textInputTypes.js'
import type { Key } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { type GlobalConfig, getGlobalConfig } from '../../../utils/config.js'
import { env } from '../../../utils/env.js'
/**
 * Helper function to check if vim mode is currently enabled
 * @returns boolean indicating if vim mode is active
 */
export function isVimModeEnabled(config: GlobalConfig = getGlobalConfig()): boolean {
  if (typeof config.tui?.vimMode === 'boolean') {
    return config.tui.vimMode
  }
  return config.editorMode === 'vim'
}

export function formatVimModeIndicator(vimMode: VimMode | undefined): string | null {
  return vimMode === undefined ? null : `-- ${vimMode} --`
}

export function getNewlineInstructions(): string {
  // Apple Terminal on macOS uses native modifier key detection for Shift+Enter
  if (env.terminal === 'Apple_Terminal' && process.platform === 'darwin') {
    return 'shift + ⏎ for newline'
  }

  // For iTerm2 and VSCode, show Shift+Enter instructions if installed
  if (getGlobalConfig().shiftEnterKeyBindingInstalled === true) {
    return 'shift + ⏎ for newline'
  }

  // Otherwise show backslash+return instructions
  return getGlobalConfig().hasUsedBackslashReturn === true
    ? '\\⏎ for newline'
    : 'backslash (\\) + return (⏎) for newline'
}

export function clampPromptTextInputColumns(columns: number): number {
  // Bordered prompt layout consumes: left/right border (2), horizontal
  // padding (2), and the prompt glyph cell (1). TextCursor subtracts one
  // more display column internally for the cursor, so return the editable
  // area plus that cursor column.
  return Math.max(0, columns - 5)
}

export function clampWorkbenchPromptTextInputColumns(
  frameColumns: number,
  permissionLabel: string,
  promptGlyph: string,
  swarmMode: boolean,
): number {
  // WorkbenchLayout has already removed the terminal breathing room and outer
  // frame, so frameColumns is the exact width inside that frame. The composer
  // then spends four cells on padding, renders a padded permission pill, a
  // two-cell gap, and the prompt glyph plus its trailing non-breaking space.
  // Swarm mode inserts its own two-cell gap and "◆ SWARM" badge.
  const horizontalPadding = 4
  const permissionPill = stringWidth(` ${permissionLabel} `)
  const permissionToPromptGap = 2
  const promptIndicator = stringWidth(`${promptGlyph}\u00a0`)
  const swarmBadge = swarmMode ? 2 + stringWidth('◆ SWARM') : 0

  // TextCursor.fromText subtracts one display column for the caret, so return
  // the editable width plus that reserve just like clampPromptTextInputColumns.
  return Math.max(
    0,
    frameColumns -
      horizontalPadding -
      permissionPill -
      swarmBadge -
      permissionToPromptGap -
      promptIndicator +
      1,
  )
}

export function pasteReferenceLineThreshold(rows: number): number {
  return Math.max(1, Math.min(Math.max(0, rows - 10), 2))
}

/**
 * True when the keystroke is a printable character that does not begin
 * with whitespace — i.e., a normal letter/digit/symbol the user typed.
 * Used to gate the lazy space inserted after an image pill.
 */
export function isNonSpacePrintable(input: string, key: Key): boolean {
  if (
    key.ctrl ||
    key.meta ||
    key.escape ||
    key.return ||
    key.tab ||
    key.backspace ||
    key.delete ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.home ||
    key.end
  ) {
    return false
  }
  return input.length > 0 && !/^\s/.test(input) && !input.startsWith('\x1b')
}
