/**
 * Worktree mode is now unconditionally enabled for all users.
 *
 * Previously gated by a remote flag whose stale first-launch cache returned
 * false and silently swallowed --worktree.
 */
export function isWorktreeModeEnabled(): boolean {
  return true
}
