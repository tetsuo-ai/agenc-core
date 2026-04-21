/**
 * `/enter-worktree <slug>` — user-facing worktree entry.
 *
 * Port of openclaude `tools/EnterWorktreeTool/EnterWorktreeTool.ts`
 * (127 LOC). Creates (or resumes) an isolated worktree at
 * `<project>/.agenc-worktrees/<slug>` and switches the current
 * session's next-turn cwd to point at it.
 *
 * @module
 */

import {
  captureBaseCommit,
  findGitRoot,
  getOrCreateWorktree,
  validateWorktreeSlug,
  type WorktreeHandle,
} from "../agents/worktree.js";
import { emitError, emitWarning } from "../session/event-log.js";
import type { Session } from "../session/session.js";

export interface EnterWorktreeOpts {
  readonly session: Session;
  readonly cwd?: string;
  readonly slug: string;
  readonly base?: string;
  readonly enableSparseCheckout?: boolean;
  readonly sparsePatterns?: ReadonlyArray<string>;
}

export type EnterWorktreeOutcome =
  | {
      readonly kind: "entered";
      readonly handle: WorktreeHandle;
      readonly baseCommit: string | null;
    }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * Enter (or resume) a worktree. Returns the handle on success; the
 * caller records session-owned worktree state so future turns resolve
 * against the worktree path without mutating process-global cwd.
 */
export async function enterWorktree(
  opts: EnterWorktreeOpts,
): Promise<EnterWorktreeOutcome> {
  const cwd = opts.cwd ?? opts.session.sessionConfiguration.cwd ?? process.cwd();
  try {
    validateWorktreeSlug(opts.slug);
  } catch (err) {
    emitError(opts.session.eventLog, opts.session.nextInternalSubId(), {
      cause: "worktree_invalid_slug",
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: "rejected",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    emitError(opts.session.eventLog, opts.session.nextInternalSubId(), {
      cause: "worktree_no_git_repo",
      message: `cwd ${cwd} is not inside a git repository`,
    });
    return {
      kind: "rejected",
      reason: `cwd ${cwd} is not inside a git repository`,
    };
  }

  let handle: WorktreeHandle;
  try {
    handle = await getOrCreateWorktree({
      gitRoot,
      slug: opts.slug,
      ...(opts.base !== undefined ? { base: opts.base } : {}),
      ...(opts.enableSparseCheckout !== undefined
        ? { enableSparseCheckout: opts.enableSparseCheckout }
        : {}),
      ...(opts.sparsePatterns !== undefined
        ? { sparsePatterns: opts.sparsePatterns }
        : {}),
    });
  } catch (err) {
    emitError(opts.session.eventLog, opts.session.nextInternalSubId(), {
      cause: "worktree_create_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: "rejected",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const baseCommit = await captureBaseCommit(gitRoot);
  if (!handle.created) {
    emitWarning(
      opts.session.eventLog,
      opts.session.nextInternalSubId(),
      "worktree_resumed",
      `resumed existing worktree at ${handle.path}`,
    );
  }

  return { kind: "entered", handle, baseCommit };
}
