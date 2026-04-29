/**
 * Composer keystroke / vim-mode helpers.
 *
 * Renamed from upstream's `utils.ts` to `promptInput-utils.ts` so the
 * import does not collide with the rest of `tui/composer/`.
 *
 * `isVimModeEnabled` mirrors upstream's config/env gate while keeping the
 * composer independent from the full ConfigStore.
 */

import type { Key } from "../ink-public.js";
import type { AgenCConfig } from "../../config/schema.js";

/**
 * Return whether vim-mode editing is active for the composer.
 *
 * Config wins; `AGENC_EDITOR_MODE=vim` is a process-level escape hatch for
 * tests, development builds, and operators who need to enable it before
 * config reload wiring runs.
 */
export function isVimModeEnabled(
  config?: Pick<AgenCConfig, "editorMode"> | null,
  env: Partial<Pick<NodeJS.ProcessEnv, "AGENC_EDITOR_MODE">> = process.env,
): boolean {
  if (config?.editorMode !== undefined) {
    return config.editorMode === "vim";
  }
  return env.AGENC_EDITOR_MODE === "vim";
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
