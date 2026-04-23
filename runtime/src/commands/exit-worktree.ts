/**
 * `/exit-worktree` — user-facing worktree teardown.
 *
 * Port of openclaude `tools/ExitWorktreeTool/ExitWorktreeTool.ts`
 * (329 LOC). The AgenC subset drops the module-level session state
 * (getCurrentWorktreeSession/tmux/analytics) and exposes a pure
 * function: the caller supplies the handle + baseCommit, this
 * decides keep vs remove, refuses to discard work without explicit
 * confirmation, and delegates the git mutations to
 * `removeAgentWorktree` (I-34 + I-35 wired there).
 *
 * Safety gate (fail-closed): when git status or rev-list cannot
 * determine worktree state, `hasWorktreeChanges` fall-through is
 * treated as "unknown → refuse remove unless discardChanges=true".
 *
 * @module
 */

import {
  hasWorktreeChanges,
  removeAgentWorktree,
  type WorktreeHandle,
} from "../agents/worktree.js";
import { emitError, emitWarning } from "../session/event-log.js";
import type { Session } from "../session/session.js";

export type ExitWorktreeAction = "keep" | "remove";

export interface ExitWorktreeOpts {
  readonly session: Session;
  readonly handle: WorktreeHandle;
  readonly baseCommit: string | null;
  readonly action: ExitWorktreeAction;
  /**
   * Must be true to force-remove a worktree with uncommitted files
   * or unmerged commits. Mirrors openclaude `discard_changes`.
   */
  readonly discardChanges?: boolean;
}

export type ExitWorktreeOutcome =
  | {
      readonly kind: "kept";
      readonly path: string;
      readonly branch: string;
      readonly changedFiles: boolean;
      readonly hasCommits: boolean;
      readonly message: string;
    }
  | {
      readonly kind: "removed";
      readonly path: string;
      readonly branch: string;
      readonly discardedFiles: boolean;
      readonly discardedCommits: boolean;
      readonly message: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly errorCode: number;
    };

/**
 * Exit (keep or remove) a worktree previously created by
 * `enterWorktree` / `getOrCreateWorktree`. The caller owns cwd
 * restoration — this function only touches git state.
 */
export async function exitWorktree(
  opts: ExitWorktreeOpts,
): Promise<ExitWorktreeOutcome> {
  // Recount at execution time. If change detection fails (git error
  // or missing base commit), treat it as unknown → refuse remove
  // without an explicit discard_changes override.
  const changes =
    opts.baseCommit !== null
      ? await safeHasChanges(opts.handle.path, opts.baseCommit)
      : null;

  if (opts.action === "remove" && !opts.discardChanges) {
    if (changes === null) {
      return {
        kind: "refused",
        reason: `could not verify worktree state at ${opts.handle.path}; refuse remove without discardChanges=true`,
        errorCode: 3,
      };
    }
    if (changes.hasCommits || changes.isDirty) {
      const parts: string[] = [];
      if (changes.isDirty) parts.push("uncommitted files");
      if (changes.hasCommits)
        parts.push(`commits on ${opts.handle.branch}`);
      return {
        kind: "refused",
        reason: `worktree has ${parts.join(" and ")}; removing will discard work. Re-invoke with discardChanges=true, or use action="keep" to preserve.`,
        errorCode: 2,
      };
    }
  }

  if (opts.action === "keep") {
    return {
      kind: "kept",
      path: opts.handle.path,
      branch: opts.handle.branch,
      changedFiles: changes?.isDirty ?? false,
      hasCommits: changes?.hasCommits ?? false,
      message: `worktree preserved at ${opts.handle.path} (branch=${opts.handle.branch})`,
    };
  }

  // action === "remove"
  try {
    await removeAgentWorktree({
      path: opts.handle.path,
      branch: opts.handle.branch,
      gitRoot: opts.handle.gitRoot,
      onSparseCheckoutOrphaned: (detail) => {
        emitWarning(
          opts.session.eventLog,
          opts.session.nextInternalSubId(),
          "sparse_checkout_orphaned",
          detail,
        );
      },
      onPruneFailed: (detail) => {
        emitWarning(
          opts.session.eventLog,
          opts.session.nextInternalSubId(),
          "worktree_prune_failed",
          detail,
        );
      },
    });
  } catch (err) {
    emitError(opts.session.eventLog, opts.session.nextInternalSubId(), {
      cause: "worktree_remove_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: "refused",
      reason: err instanceof Error ? err.message : String(err),
      errorCode: 4,
    };
  }

  return {
    kind: "removed",
    path: opts.handle.path,
    branch: opts.handle.branch,
    discardedFiles: changes?.isDirty ?? false,
    discardedCommits: changes?.hasCommits ?? false,
    message: `worktree removed at ${opts.handle.path} (branch=${opts.handle.branch})`,
  };
}

async function safeHasChanges(
  path: string,
  baseCommit: string,
): Promise<{ hasCommits: boolean; isDirty: boolean } | null> {
  try {
    return await hasWorktreeChanges({ path, baseCommit });
  } catch {
    return null;
  }
}
