import type { Key } from '../../ink.js'
import type { GlobalRuntimeState } from '../../../config/runtime-state-repository.js'
import { env } from '../../../utils/env.js'
export function getNewlineInstructions(
  runtimeState: Pick<
    GlobalRuntimeState,
    'shiftEnterKeyBindingInstalled' | 'hasUsedBackslashReturn'
  >,
): string {
  // Apple Terminal on macOS uses native modifier key detection for Shift+Enter
  if (env.terminal === 'Apple_Terminal' && process.platform === 'darwin') {
    return 'shift + ⏎ for newline'
  }

  // For iTerm2 and VSCode, show Shift+Enter instructions if installed
  if (runtimeState.shiftEnterKeyBindingInstalled === true) {
    return 'shift + ⏎ for newline'
  }

  // Otherwise show backslash+return instructions
  return runtimeState.hasUsedBackslashReturn === true
    ? '\\⏎ for newline'
    : 'backslash (\\) + return (⏎) for newline'
}

/** Margin and padding of the borderless prompt band, on each side. */
export const PROMPT_BAND_MARGIN_X = 2
export const PROMPT_BAND_PADDING_X = 1
/** The mode indicator in front of the text: the prompt glyph and a space. */
const PROMPT_MODE_INDICATOR_COLUMNS = 2

/**
 * Width to give the prompt's text input: exactly the columns the layout
 * leaves for text. TextCursor keeps one of them for the cursor. A larger
 * value makes every full line spill its last characters onto an extra row,
 * and the cursor then lands one row too low.
 */
export function clampPromptTextInputColumns(
  columns: number,
  layout: 'band' | 'banner' = 'band',
): number {
  const chrome =
    layout === 'banner'
      ? PROMPT_MODE_INDICATOR_COLUMNS
      : 2 * PROMPT_BAND_MARGIN_X +
        2 * PROMPT_BAND_PADDING_X +
        PROMPT_MODE_INDICATOR_COLUMNS
  return Math.max(0, columns - chrome)
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
