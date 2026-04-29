/**
 * Bash-history ghost completion for the `!`-prefixed bash mode.
 *
 * Ported from upstream as a no-op stub. Upstream sources completions
 * from a process-wide shell-history backend; AgenC does not maintain a
 * shell-history store yet (the composer only persists submitted
 * prompts via `tui/composer/history.ts`, which is prompt history, not
 * shell history). The shape is preserved so the inline ghost-text
 * pipeline can call this module unconditionally — when AgenC ships a
 * shell-history backend, this is the seam to wire it through.
 *
 * TODO(tranche-5B): wire to a future shell-history backend.
 */

export interface ShellHistoryMatch {
  /** The full command from history. */
  readonly fullCommand: string;
  /** The suffix to display as ghost text after the user's input. */
  readonly suffix: string;
}

/** Cache hook preserved so callers can flush state on submit. No-op today. */
export function clearShellHistoryCache(): void {
  // No backend to clear.
}

/**
 * Cache-hint hook called when a new bash command is submitted. No-op
 * today; preserved so upstream-shaped callers compile cleanly.
 */
export function prependToShellHistoryCache(_command: string): void {
  // No backend to prepend to.
}

/**
 * Return the best matching shell command for the current input, or
 * `null` when no shell-history source is available.
 *
 * AgenC always returns `null` until a shell-history backend lands.
 */
export async function getShellHistoryCompletion(
  _input: string,
): Promise<ShellHistoryMatch | null> {
  return null;
}
