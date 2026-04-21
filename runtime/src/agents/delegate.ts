/**
 * Delegate — the AgentTool spawn dispatcher.
 *
 * Hand-port of openclaude `tools/AgentTool/AgentTool.tsx` (1,232 LOC)
 * spawn-dispatcher subset. Public entry point for:
 *
 *   - Isolation setup (worktree create + bind CWD, or CWD-only)
 *   - Fork mode selection
 *   - Sync vs async mode routing
 *   - Teardown (worktree remove if clean, keep/remove choice if dirty)
 *
 * AgenC's T9 ships the single `delegate()` entry; the TUI command
 * layer (T11) wires it into slash commands. Async mode registers
 * the thread with AgentControl and returns immediately; sync mode
 * awaits completion.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { AgentControl } from "./control.js";
import type { AgentRegistry, AgentPath } from "./registry.js";
import type { ForkMode } from "./fork-context.js";
import type { WorktreeHandle } from "./worktree.js";
import type { AgentThread } from "./thread.js";
import type { RunAgentResult } from "./run-agent.js";
import { emitWarning } from "../session/event-log.js";
import { AgentThread as AgentThreadClass } from "./thread.js";
import { forkSubagent } from "./fork-context.js";
import {
  getOrCreateWorktree,
  findGitRoot,
  hasWorktreeChanges,
  captureBaseCommit,
  removeAgentWorktree,
} from "./worktree.js";
import { runAgent } from "./run-agent.js";
import { ResumeManager } from "./resume.js";

// ─────────────────────────────────────────────────────────────────────
// Delegate options
// ─────────────────────────────────────────────────────────────────────

export type IsolationMode = "none" | "cwd" | "worktree";

export interface DelegateOpts {
  readonly parent: Session;
  readonly parentPath: AgentPath;
  readonly control: AgentControl;
  readonly registry: AgentRegistry;
  readonly taskPrompt: string;
  readonly role?: string;
  readonly isolation?: IsolationMode;
  readonly worktreeSlug?: string;
  readonly forkMode?: ForkMode;
  readonly runInBackground?: boolean;
  readonly toolAllowlist?: ReadonlyArray<string>;
  readonly resumeManager?: ResumeManager;
}

export type DelegateOutcome =
  | { readonly kind: "sync_completed"; readonly result: RunAgentResult; readonly thread: AgentThread }
  | { readonly kind: "async_launched"; readonly thread: AgentThread }
  | { readonly kind: "rejected"; readonly reason: string };

// ─────────────────────────────────────────────────────────────────────
// delegate — main entry
// ─────────────────────────────────────────────────────────────────────

export async function delegate(
  opts: DelegateOpts,
): Promise<DelegateOutcome> {
  const isolation = opts.isolation ?? "none";
  const forkMode = opts.forkMode ?? { kind: "new" };
  const runInBackground = opts.runInBackground ?? false;

  // Set up worktree if requested.
  let worktree: WorktreeHandle | undefined;
  let baseCommit: string | null = null;
  if (isolation === "worktree" && opts.worktreeSlug) {
    const workspaceRoot =
      opts.parent.sessionConfiguration.cwd ||
      opts.parent.config.cwd ||
      process.cwd();
    const gitRoot = findGitRoot(workspaceRoot);
    if (!gitRoot) {
      return {
        kind: "rejected",
        reason: "worktree isolation requested but cwd is not inside a git repository",
      };
    }
    try {
      worktree = await getOrCreateWorktree({
        gitRoot,
        slug: opts.worktreeSlug,
      });
      baseCommit = await captureBaseCommit(gitRoot);
    } catch (err) {
      return {
        kind: "rejected",
        reason: `worktree setup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Spawn the live agent (AgentControl owns depth + slot + metadata).
  let live;
  try {
    live = await opts.control.spawn({
      parentPath: opts.parentPath,
      ...(opts.role !== undefined ? { roleName: opts.role } : {}),
    });
  } catch (err) {
    // Teardown worktree if we created one — slot reservation rolled back.
    if (worktree?.created) {
      await removeAgentWorktree({
        path: worktree.path,
        branch: worktree.branch,
        gitRoot: worktree.gitRoot,
      }).catch(() => {});
    }
    return {
      kind: "rejected",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Build the fork context.
  const fork = await forkSubagent({
    parent: opts.parent,
    parentMessages: [],
    mode: forkMode,
    taskPrompt: opts.taskPrompt,
    ...(worktree?.path !== undefined ? { worktreePath: worktree.path } : {}),
  });

  const buildThread = (
    wiring: ConstructorParameters<typeof AgentThreadClass>[1] = {},
  ): AgentThread =>
    new AgentThreadClass(
      {
        live,
        initialMessages: fork.messages,
        forkMode,
        ...(worktree !== undefined ? { worktree } : {}),
        parentSessionId: opts.parent.conversationId,
        taskPrompt: opts.taskPrompt,
      },
      {
        parent: opts.parent,
        control: opts.control,
        registry: opts.registry,
        parentPath: live.agentPath,
        ...wiring,
      },
    );

  if (runInBackground || live.role.config.background) {
    // Async mode — fire-and-forget; caller sees the AgentThread handle.
    let thread!: AgentThread;
    const joinPromise = (async () => {
      try {
        const iter = runAgent({
          live,
          parent: opts.parent,
          initialMessages: fork.messages,
          taskPrompt: opts.taskPrompt,
          ...(worktree !== undefined ? { worktree } : {}),
          ...(opts.toolAllowlist !== undefined
            ? { toolAllowlist: opts.toolAllowlist }
            : {}),
        });
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const step = await iter.next();
          if (step.done) {
            return step.value;
          }
        }
      } finally {
        await teardown({
          thread,
          control: opts.control,
          registry: opts.registry,
          parent: opts.parent,
          ...(baseCommit !== null ? { baseCommit } : {}),
        });
      }
    })();
    thread = buildThread({ joinPromise });
    return { kind: "async_launched", thread };
  }

  const thread = buildThread();

  // Sync mode — await completion.
  const iter = runAgent({
    live,
    parent: opts.parent,
    initialMessages: fork.messages,
    taskPrompt: opts.taskPrompt,
    ...(worktree !== undefined ? { worktree } : {}),
    ...(opts.toolAllowlist !== undefined
      ? { toolAllowlist: opts.toolAllowlist }
      : {}),
  });
  let result: RunAgentResult | undefined;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const step = await iter.next();
      if (step.done) {
        result = step.value;
        break;
      }
    }
  } finally {
    await teardown({
      thread,
      control: opts.control,
      registry: opts.registry,
      parent: opts.parent,
      ...(baseCommit !== null ? { baseCommit } : {}),
    });
  }

  return {
    kind: "sync_completed",
    result: result!,
    thread,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Teardown
// ─────────────────────────────────────────────────────────────────────

async function teardown(opts: {
  readonly thread: AgentThread;
  readonly control: AgentControl;
  readonly registry: AgentRegistry;
  readonly parent: Session;
  readonly baseCommit?: string;
}): Promise<void> {
  void opts.registry;

  // Shut down the live agent (cascades descendants, closes mailboxes).
  await opts.control.shutdown(opts.thread.threadId, "delegate_teardown");

  // If we own a worktree, decide keep-vs-remove.
  if (opts.thread.worktree && opts.baseCommit) {
    try {
      const changes = await hasWorktreeChanges({
        path: opts.thread.worktree.path,
        baseCommit: opts.baseCommit,
      });
      if (!changes.hasCommits && !changes.isDirty) {
        await removeAgentWorktree({
          path: opts.thread.worktree.path,
          branch: opts.thread.worktree.branch,
          gitRoot: opts.thread.worktree.gitRoot,
          onSparseCheckoutOrphaned: (detail) => {
            emitWarning(
              opts.parent.eventLog,
              opts.parent.nextInternalSubId(),
              "sparse_checkout_orphaned",
              detail,
            );
          },
          onPruneFailed: (detail) => {
            emitWarning(
              opts.parent.eventLog,
              opts.parent.nextInternalSubId(),
              "worktree_prune_failed",
              detail,
            );
          },
        });
      } else {
        // Dirty/has-commits — leave for ExitWorktreeTool to handle.
        emitWarning(
          opts.parent.eventLog,
          opts.parent.nextInternalSubId(),
          "worktree_has_changes",
          `worktree ${opts.thread.worktree.path} has changes (commits=${changes.hasCommits}, dirty=${changes.isDirty}); keep/remove handled by ExitWorktreeTool`,
        );
      }
    } catch (err) {
      emitWarning(
        opts.parent.eventLog,
        opts.parent.nextInternalSubId(),
        "worktree_teardown_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
