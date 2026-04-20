/**
 * Slash-command dispatcher for the `agenc` CLI entry point.
 *
 * Two commands are wired today (T9):
 *
 *   /enter-worktree <slug>
 *   /exit-worktree <keep|remove> [--discard]
 *
 * These short-circuit the normal `runTurn` flow: the CLI calls
 * `parseSlashCommand(line)` before handing the text to the provider,
 * and if a command matches we run the corresponding `commands/*`
 * handler and return the outcome without invoking the LLM.
 *
 * The T11 tranche will land the full slash dispatcher + help system;
 * this module is the minimum wiring the user can rely on today.
 *
 * @module
 */

import { enterWorktree } from "../commands/enter-worktree.js";
import { exitWorktree } from "../commands/exit-worktree.js";
import type { WorktreeHandle } from "../agents/worktree.js";
import type { Session } from "../session/session.js";

export type SlashCommand =
  | { readonly kind: "enter_worktree"; readonly slug: string }
  | {
      readonly kind: "exit_worktree";
      readonly action: "keep" | "remove";
      readonly discardChanges: boolean;
    };

export interface PendingWorktreeState {
  readonly handle: WorktreeHandle;
  readonly baseCommit: string | null;
  readonly enteredFromCwd: string;
}

export interface SlashHandleResult {
  /** True when the line matched a slash command (LLM turn should be skipped). */
  readonly matched: boolean;
  /** Exit code hint — 0 on success, non-zero on rejection. */
  readonly exitCode: number;
  /** Plain-text summary to emit on stdout/stderr. */
  readonly message: string;
  /** Updated pending-worktree state (or the unchanged input when no state change). */
  readonly pendingWorktree: PendingWorktreeState | null;
  /** Updated cwd — callers `process.chdir` to this if different. */
  readonly cwd: string;
}

const ENTER_RE = /^\/enter-worktree\s+(\S+)\s*$/;
const EXIT_RE = /^\/exit-worktree\s+(keep|remove)(?:\s+(--discard))?\s*$/;

/**
 * Parse a raw prompt into a SlashCommand, or return null if it's not
 * a slash command the CLI knows about. Only matches when the line
 * starts with `/` to avoid grabbing user text that happens to contain
 * a slash mid-sentence.
 */
export function parseSlashCommand(line: string): SlashCommand | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;

  const enter = trimmed.match(ENTER_RE);
  if (enter) {
    return { kind: "enter_worktree", slug: enter[1]! };
  }

  const exit = trimmed.match(EXIT_RE);
  if (exit) {
    const action = exit[1] as "keep" | "remove";
    const discard = exit[2] === "--discard";
    return { kind: "exit_worktree", action, discardChanges: discard };
  }

  return null;
}

export interface HandleSlashOpts {
  readonly session: Session;
  readonly command: SlashCommand;
  readonly originalCwd: string;
  readonly pendingWorktree: PendingWorktreeState | null;
  /** Override `enterWorktree` for tests. */
  readonly enterWorktreeFn?: typeof enterWorktree;
  /** Override `exitWorktree` for tests. */
  readonly exitWorktreeFn?: typeof exitWorktree;
}

/**
 * Run a parsed slash command. Does NOT call `process.chdir` — returns
 * the new cwd in the result so the caller can decide how to apply it
 * (the CLI does `process.chdir(result.cwd)` inline; tests inspect the
 * returned value).
 */
export async function handleSlashCommand(
  opts: HandleSlashOpts,
): Promise<SlashHandleResult> {
  const enterFn = opts.enterWorktreeFn ?? enterWorktree;
  const exitFn = opts.exitWorktreeFn ?? exitWorktree;

  switch (opts.command.kind) {
    case "enter_worktree": {
      const outcome = await enterFn({
        session: opts.session,
        slug: opts.command.slug,
      });
      if (outcome.kind === "rejected") {
        return {
          matched: true,
          exitCode: 1,
          message: `enter-worktree rejected: ${outcome.reason}`,
          pendingWorktree: opts.pendingWorktree,
          cwd: opts.pendingWorktree?.handle.path ?? opts.originalCwd,
        };
      }
      const pending: PendingWorktreeState = {
        handle: outcome.handle,
        baseCommit: outcome.baseCommit,
        enteredFromCwd: opts.originalCwd,
      };
      return {
        matched: true,
        exitCode: 0,
        message: `entered worktree ${outcome.handle.path} (branch=${outcome.handle.branch}, created=${outcome.handle.created})`,
        pendingWorktree: pending,
        cwd: outcome.handle.path,
      };
    }

    case "exit_worktree": {
      const active = opts.pendingWorktree;
      if (!active) {
        return {
          matched: true,
          exitCode: 1,
          message:
            "exit-worktree rejected: no active worktree in this session",
          pendingWorktree: null,
          cwd: opts.originalCwd,
        };
      }
      const outcome = await exitFn({
        session: opts.session,
        handle: active.handle,
        baseCommit: active.baseCommit,
        action: opts.command.action,
        ...(opts.command.discardChanges
          ? { discardChanges: true }
          : {}),
      });

      if (outcome.kind === "refused") {
        return {
          matched: true,
          exitCode: outcome.errorCode > 0 ? outcome.errorCode : 1,
          message: `exit-worktree refused: ${outcome.reason}`,
          pendingWorktree: active,
          cwd: active.handle.path,
        };
      }
      if (outcome.kind === "kept") {
        // Keep: preserve the worktree + stay bound to its cwd.
        return {
          matched: true,
          exitCode: 0,
          message: outcome.message,
          pendingWorktree: active,
          cwd: active.handle.path,
        };
      }
      // Removed: drop the pending handle + restore the original cwd.
      return {
        matched: true,
        exitCode: 0,
        message: outcome.message,
        pendingWorktree: null,
        cwd: active.enteredFromCwd,
      };
    }
  }
}
