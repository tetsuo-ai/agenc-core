/**
 * Composer keystroke / vim-mode helpers.
 *
 * Renamed from upstream's `utils.ts` to `promptInput-utils.ts` so the
 * import does not collide with the rest of `tui/composer/`.
 *
 * `isVimModeEnabled` is a stub: AgenC has no `editorMode: "vim"` config
 * slot today. Toggle resolution is wired up in tranche 5B.
 */

import type { Key } from "../ink-public.js";

/**
 * Return whether vim-mode editing is active for the composer. AgenC
 * config currently has no `editorMode` slot, so this always returns
 * `false`. The hook is kept as a function so the eventual config wiring
 * stays a one-line change.
 */
// TODO(tranche-5): wire vim mode to AgenC config
export function isVimModeEnabled(): boolean {
  return false;
}

/**
 * Display string used by the composer footer to remind the operator
 * which key inserts a literal newline. AgenC ships a fixed binding
 * (`shift+enter` / `ctrl+j`) so we always print the upstream-style
 * "shift + ⏎" hint; the backslash-return fallback is intentionally
 * dropped because AgenC has not shipped that input path.
 */
export function getNewlineInstructions(): string {
  return "shift + ⏎ for newline";
}

/**
 * `true` when the keypress is a printable character that does not
 * begin with whitespace. Used to gate the lazy space inserted after
 * an image pill.
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
    return false;
  }
  return input.length > 0 && !/^\s/u.test(input) && !input.startsWith("\x1b");
}
