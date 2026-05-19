import type { WorktreeHandle } from "../agents/worktree.js";

/**
 * Session-local binding for an active CLI worktree entered through the
 * slash-command adapters. This keeps just enough state for `/exit-worktree`
 * to restore the original cwd and decide keep/remove against the same
 * handle/baseCommit captured on `/enter-worktree`.
 */
export interface PendingWorktreeState {
  readonly handle: WorktreeHandle;
  readonly baseCommit: string | null;
  readonly originalCwd: string;
}
