/**
 * `EnterWorktree` / `ExitWorktree` — port of donor `EnterWorktreeTool`
 * + `ExitWorktreeTool`. The model-facing prompts (`prompt.ts`) and input
 * schemas are byte-identical to upstream where the AgenC contract permits.
 *
 * What's ported verbatim:
 *   - Tool names: `EnterWorktree`, `ExitWorktree`.
 *   - Schema for EnterWorktree: `{ name?: string }` with the same slug
 *     restrictions ("/-separated segments of letters/digits/dots/
 *     underscores/dashes; max 64 chars total").
 *   - Schema for ExitWorktree: `{ action: "keep" | "remove",
 *     discard_changes?: boolean }`.
 *   - Prompt text from `EnterWorktreeTool/prompt.ts:1-30` and
 *     `ExitWorktreeTool/prompt.ts:1-32`, byte-for-byte.
 *   - Behavior:
 *       - EnterWorktree refuses if a session-level worktree is already
 *         active.
 *       - EnterWorktree auto-generates a name from the AgenC plan slug
 *         if none was supplied (matches AgenC's
 *         `getPlanSlug()` fallback at `EnterWorktreeTool.ts:90`).
 *       - ExitWorktree no-ops with the upstream message when no
 *         session-level worktree is active.
 *       - ExitWorktree refuses `action: "remove"` when the worktree
 *         has uncommitted files or extra commits unless
 *         `discard_changes: true` is explicitly set, with the same
 *         error format upstream uses.
 *
 * What is intentionally adapted:
 *   - `process.chdir` is not called on EnterWorktree. AgenC's runtime
 *     keeps cwd stable for the session — tool-side "switch cwd" would
 *     race with concurrent tool calls. Instead the worktree session
 *     records `worktreePath` and exposes it via the workflow controller
 *     so subsequent `exec_command` / `Edit` / `Write` invocations that
 *     accept an explicit `cwd` / `workdir` arg can target it. The
 *     "session is now working in the worktree" prompt text is
 *     preserved so the model reads the upstream contract; if the model
 *     wants subsequent commands to run in the worktree it must pass
 *     `cwd: <worktreePath>` to `exec_command`.
 *   - The session-level `currentWorktreeSession` is an in-process
 *     module singleton (matches AgenC's `getCurrentWorktreeSession`
 *     at `utils/worktree.js`). For multi-session daemons this is
 *     keyed on the donor-style `__agencSessionId` injected arg so child
 *     agents and the main session each get their own slot.
 *
 * @module
 */

import { resolve } from "node:path";

import { runCommand } from "../../utils/process.js";
import {
  getPlanFilePath,
  getPlansDirectory,
} from "../../planning/plan-files.js";
import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { plainTextErrorToolResult as errorResult } from "../results.js";

// ─────────────────────────────────────────────────────────────────────
// Session-level worktree state — module singleton keyed by AgenC
// session id. Mirrors donor `getCurrentWorktreeSession()` /
// `setCurrentWorktreeSession()` from `utils/worktree.js`. The state
// is intentionally in-memory only: AgenC persists it via
// `saveWorktreeState(...)` so it survives session reloads, but for
// AgenC's runtime that lives across daemon restarts we keep it
// in-memory and let the model re-establish on resume.
// ─────────────────────────────────────────────────────────────────────

interface WorktreeSession {
  readonly sessionId: string;
  readonly slug: string;
  readonly worktreePath: string;
  readonly worktreeBranch: string | undefined;
  readonly originalCwd: string;
  readonly originalHeadCommit: string | undefined;
  readonly mainRepoRoot: string;
  readonly createdAt: number;
}

const worktreeSessions = new Map<string, WorktreeSession>();

function getCurrentWorktreeSession(
  sessionId: string,
): WorktreeSession | undefined {
  return worktreeSessions.get(sessionId);
}

function setCurrentWorktreeSession(
  sessionId: string,
  session: WorktreeSession | null,
): void {
  if (session === null) {
    worktreeSessions.delete(sessionId);
  } else {
    worktreeSessions.set(sessionId, session);
  }
}

/**
 * Validate an upstream-style worktree slug. Mirrors the regex
 * upstream uses at `utils/worktree.ts:validateWorktreeSlug`:
 * "/-separated segments of letters/digits/dots/underscores/dashes;
 *  max 64 chars total."
 */
export function validateWorktreeSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("worktree name must be a non-empty string");
  }
  if (slug.length > 64) {
    throw new Error("worktree name exceeds 64 characters");
  }
  for (const segment of slug.split("/")) {
    if (segment.length === 0) {
      throw new Error("worktree name has an empty segment");
    }
    // gaphunt3 #7: reject "." / ".." segments so the slug cannot
    // traverse out of .agenc/worktrees via resolve(). The
    // `^[A-Za-z0-9._-]+$` class below treats ".." as a legal segment
    // (`.` is allowed), so this explicit guard — present in the donor
    // `utils/worktree.ts:validateWorktreeSlug` but dropped in the port —
    // is required to preserve the confinement check.
    if (segment === "." || segment === "..") {
      throw new Error(
        `worktree name must not contain "." or ".." path segments`,
      );
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error(
        `worktree segment "${segment}" contains characters other than letters, digits, dots, underscores, or dashes`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Verbatim ports of AgenC prompts
// ─────────────────────────────────────────────────────────────────────

const ENTER_WORKTREE_PROMPT = `Use this tool ONLY when the user explicitly asks to work in a worktree. This tool creates an isolated git worktree and switches the current session into it.

## When to Use

- The user explicitly says "worktree" (e.g., "start a worktree", "work in a worktree", "create a worktree", "use a worktree")

## When NOT to Use

- The user asks to create a branch, switch branches, or work on a different branch — use git commands instead
- The user asks to fix a bug or work on a feature — use normal git workflow unless they specifically mention worktrees
- Never use this tool unless the user explicitly mentions "worktree"

## Requirements

- Must be in a git repository, OR have WorktreeCreate/WorktreeRemove hooks configured in settings.json
- Must not already be in a worktree

## Behavior

- In a git repository: creates a new git worktree inside \`.agenc/worktrees/\` with a new branch based on HEAD
- Outside a git repository: delegates to WorktreeCreate/WorktreeRemove hooks for VCS-agnostic isolation
- Switches the session's working directory to the new worktree
- Use ExitWorktree to leave the worktree mid-session (keep or remove). On session exit, if still in the worktree, the user will be prompted to keep or remove it

## Parameters

- \`name\` (optional): A name for the worktree. If not provided, a random name is generated.
`;

const EXIT_WORKTREE_PROMPT = `Exit a worktree session created by EnterWorktree and return the session to the original working directory.

## Scope

This tool ONLY operates on worktrees created by EnterWorktree in this session. It will NOT touch:
- Worktrees you created manually with \`git worktree add\`
- Worktrees from a previous session (even if created by EnterWorktree then)
- The directory you're in if EnterWorktree was never called

If called outside an EnterWorktree session, the tool is a **no-op**: it reports that no worktree session is active and takes no action. Filesystem state is unchanged.

## When to Use

- The user explicitly asks to "exit the worktree", "leave the worktree", "go back", or otherwise end the worktree session
- Do NOT call this proactively — only when the user asks

## Parameters

- \`action\` (required): \`"keep"\` or \`"remove"\`
  - \`"keep"\` — leave the worktree directory and branch intact on disk. Use this if the user wants to come back to the work later, or if there are changes to preserve.
  - \`"remove"\` — delete the worktree directory and its branch. Use this for a clean exit when the work is done or abandoned.
- \`discard_changes\` (optional, default false): only meaningful with \`action: "remove"\`. If the worktree has uncommitted files or commits not on the original branch, the tool will REFUSE to remove it unless this is set to \`true\`. If the tool returns an error listing changes, confirm with the user before re-invoking with \`discard_changes: true\`.

## Behavior

- Restores the session's working directory to where it was before EnterWorktree
- Clears CWD-dependent caches so the session state reflects the original directory
- Once exited, EnterWorktree can be called again to create a fresh worktree
`;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function okResult(data: Record<string, unknown>, message: string): ToolResult {
  return {
    content: message,
    metadata: data,
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

async function findGitRoot(cwd: string): Promise<string | null> {
  const result = await runCommand(
    "git",
    ["-C", cwd, "rev-parse", "--show-toplevel"],
    { cwd },
  );
  if (result.exitCode !== 0) return null;
  const path = result.stdout.trim();
  return path.length > 0 ? path : null;
}

async function getCurrentHeadCommit(cwd: string): Promise<string | undefined> {
  const result = await runCommand(
    "git",
    ["-C", cwd, "rev-parse", "HEAD"],
    { cwd },
  );
  if (result.exitCode !== 0) return undefined;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : undefined;
}

interface ChangeSummary {
  readonly changedFiles: number;
  readonly commits: number;
}

/**
 * Mirrors donor `countWorktreeChanges`
 * (`ExitWorktreeTool.ts:79-113`). Returns null when state cannot be
 * reliably determined (lock file, corrupt index, missing baseline);
 * callers MUST treat null as "unknown, fail closed" rather than 0/0.
 */
async function countWorktreeChanges(
  worktreePath: string,
  originalHeadCommit: string | undefined,
): Promise<ChangeSummary | null> {
  const status = await runCommand(
    "git",
    ["-C", worktreePath, "status", "--porcelain"],
    { cwd: worktreePath },
  );
  if (status.exitCode !== 0) return null;
  const changedFiles = status.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0).length;

  if (originalHeadCommit === undefined) {
    // git status worked → real git repo, but no baseline to count
    // commits against. Fail closed.
    return null;
  }

  const revList = await runCommand(
    "git",
    [
      "-C",
      worktreePath,
      "rev-list",
      "--count",
      `${originalHeadCommit}..HEAD`,
    ],
    { cwd: worktreePath },
  );
  if (revList.exitCode !== 0) return null;
  const commits = parseInt(revList.stdout.trim(), 10);
  return { changedFiles, commits: Number.isFinite(commits) ? commits : 0 };
}

function resolveSessionId(
  args: Record<string, unknown>,
): string | undefined {
  return asNonEmptyString(
    (args as ToolExecutionInjectedArgs & { __agencSessionId?: unknown })
      .__agencSessionId,
  );
}

function defaultPlanCtx(sessionId: string): {
  readonly sessionId: string;
  readonly agencHome?: string;
} {
  if (
    typeof process.env.AGENC_HOME === "string" &&
    process.env.AGENC_HOME.length > 0
  ) {
    return { sessionId, agencHome: process.env.AGENC_HOME };
  }
  return { sessionId };
}

// ─────────────────────────────────────────────────────────────────────
// EnterWorktree
// ─────────────────────────────────────────────────────────────────────

export interface WorktreeToolConfig {
  readonly cwd: string;
}

export function createEnterWorktreeTool(config: WorktreeToolConfig): Tool {
  return {
    name: "EnterWorktree",
    description: ENTER_WORKTREE_PROMPT,
    metadata: {
      family: "git",
      source: "builtin",
      keywords: ["worktree", "isolate", "branch", "create"],
      preferredProfiles: ["coding", "operator"],
      hiddenByDefault: false,
      mutating: true,
      deferred: true,
    },
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Optional name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.',
        },
      },
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as ToolExecutionInjectedArgs & { name?: unknown };
      const sessionId = resolveSessionId(rawArgs);
      if (sessionId === undefined) {
        return errorResult(
          "EnterWorktree requires session context (no __agencSessionId injected); call from a session-bound dispatcher.",
        );
      }
      // Refuse if this session already has an active worktree —
      // matches donor `EnterWorktreeTool.call:79-81`.
      const existing = getCurrentWorktreeSession(sessionId);
      if (existing !== undefined) {
        return errorResult(
          `Already in a worktree session at ${existing.worktreePath}. Use ExitWorktree first.`,
        );
      }

      const slugRaw = asNonEmptyString(args.name);
      let slug: string;
      if (slugRaw !== undefined) {
        try {
          validateWorktreeSlug(slugRaw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(message);
        }
        slug = slugRaw;
      } else {
        // Auto-name: use the AgenC plan slug. Mirrors donor
        // `EnterWorktreeTool.call:90` which calls `getPlanSlug()`.
        const planFilePath = getPlanFilePath(defaultPlanCtx(sessionId));
        // getPlanFilePath returns `<plansDir>/<slug>.md`. Extract the slug.
        const plansDir = getPlansDirectory(defaultPlanCtx(sessionId));
        const filename = planFilePath.startsWith(plansDir)
          ? planFilePath.slice(plansDir.length).replace(/^\/+/, "")
          : planFilePath;
        slug = filename.replace(/\.md$/, "");
      }

      const startCwd = resolve(config.cwd);
      const mainRepoRoot = await findGitRoot(startCwd);
      if (mainRepoRoot === null) {
        return errorResult(
          `Not in a git repository (no rev-parse --show-toplevel from ${startCwd}). EnterWorktree requires a git repo or configured WorktreeCreate hooks (the latter aren't yet wired in AgenC).`,
        );
      }

      // Create the worktree under AgenC's internal worktree directory.
      const worktreesRoot = resolve(mainRepoRoot, ".agenc", "worktrees");
      const worktreePath = resolve(worktreesRoot, slug);
      // gaphunt3 #7: defense-in-depth — even after slug validation,
      // confirm the resolved path stays inside .agenc/worktrees before
      // handing it to `git worktree add`. Blocks any future regression in
      // validateWorktreeSlug from escaping the confinement root.
      if (
        worktreePath !== worktreesRoot &&
        !worktreePath.startsWith(`${worktreesRoot}/`)
      ) {
        return errorResult(
          `Refusing to create worktree: resolved path ${worktreePath} escapes ${worktreesRoot}.`,
        );
      }
      const branch = slug;
      const originalHeadCommit = await getCurrentHeadCommit(mainRepoRoot);

      const create = await runCommand(
        "git",
        [
          "-C",
          mainRepoRoot,
          "worktree",
          "add",
          "-b",
          branch,
          worktreePath,
        ],
        { cwd: mainRepoRoot },
      );
      if (create.exitCode !== 0) {
        const errText =
          create.stderr.trim() ||
          create.stdout.trim() ||
          "git worktree add failed";
        return errorResult(`Failed to create worktree: ${errText}`);
      }

      const session: WorktreeSession = {
        sessionId,
        slug,
        worktreePath,
        worktreeBranch: branch,
        originalCwd: startCwd,
        originalHeadCommit,
        mainRepoRoot,
        createdAt: Date.now(),
      };
      setCurrentWorktreeSession(sessionId, session);

      const branchInfo = ` on branch ${branch}`;
      const message =
        `Created worktree at ${worktreePath}${branchInfo}. The session is now working in the worktree. ` +
        `Use ExitWorktree to leave mid-session, or exit the session to be prompted. ` +
        `Pass \`cwd: "${worktreePath}"\` to exec_command, Edit, and Write invocations that should target the worktree.`;
      return okResult(
        {
          worktreePath,
          worktreeBranch: branch,
          message,
        },
        message,
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// ExitWorktree
// ─────────────────────────────────────────────────────────────────────

export function createExitWorktreeTool(_config: WorktreeToolConfig): Tool {
  void _config;
  return {
    name: "ExitWorktree",
    description: EXIT_WORKTREE_PROMPT,
    metadata: {
      family: "git",
      source: "builtin",
      keywords: ["worktree", "exit", "leave", "remove", "keep"],
      preferredProfiles: ["coding", "operator"],
      hiddenByDefault: false,
      mutating: true,
      deferred: true,
    },
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["keep", "remove"],
          description:
            '"keep" leaves the worktree and branch on disk; "remove" deletes both.',
        },
        discard_changes: {
          type: "boolean",
          description:
            'Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise.',
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as ToolExecutionInjectedArgs & {
        action?: unknown;
        discard_changes?: unknown;
      };
      const sessionId = resolveSessionId(rawArgs);
      if (sessionId === undefined) {
        return errorResult(
          "ExitWorktree requires session context (no __agencSessionId injected).",
        );
      }
      const action = asNonEmptyString(args.action);
      if (action !== "keep" && action !== "remove") {
        return errorResult('action must be "keep" or "remove"');
      }
      const discardChanges = args.discard_changes === true;

      const session = getCurrentWorktreeSession(sessionId);
      if (session === undefined) {
        // Verbatim no-op message from AgenC
        // `ExitWorktreeTool.validateInput:182-188`.
        return errorResult(
          "No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made.",
        );
      }

      if (action === "remove" && !discardChanges) {
        const summary = await countWorktreeChanges(
          session.worktreePath,
          session.originalHeadCommit,
        );
        if (summary === null) {
          return errorResult(
            `Could not verify worktree state at ${session.worktreePath}. Refusing to remove without explicit confirmation. Re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.`,
          );
        }
        const { changedFiles, commits } = summary;
        if (changedFiles > 0 || commits > 0) {
          const parts: string[] = [];
          if (changedFiles > 0) {
            parts.push(
              `${changedFiles} uncommitted ${changedFiles === 1 ? "file" : "files"}`,
            );
          }
          if (commits > 0) {
            parts.push(
              `${commits} ${commits === 1 ? "commit" : "commits"} on ${session.worktreeBranch ?? "the worktree branch"}`,
            );
          }
          return errorResult(
            `Worktree has ${parts.join(" and ")}. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
          );
        }
      }

      // Re-count for accurate analytics (matches AgenC
      // `ExitWorktreeTool.call:256-259`). Null falls back to 0/0.
      const finalSummary =
        (await countWorktreeChanges(
          session.worktreePath,
          session.originalHeadCommit,
        )) ?? { changedFiles: 0, commits: 0 };

      if (action === "keep") {
        setCurrentWorktreeSession(sessionId, null);
        const message = `Exited worktree. Your work is preserved at ${session.worktreePath}${
          session.worktreeBranch !== undefined
            ? ` on branch ${session.worktreeBranch}`
            : ""
        }. Session is now back in ${session.originalCwd}.`;
        return okResult(
          {
            action: "keep",
            originalCwd: session.originalCwd,
            worktreePath: session.worktreePath,
            worktreeBranch: session.worktreeBranch,
            message,
          },
          message,
        );
      }

      // action === "remove"
      const remove = await runCommand(
        "git",
        [
          "-C",
          session.mainRepoRoot,
          "worktree",
          "remove",
          "--force",
          session.worktreePath,
        ],
        { cwd: session.mainRepoRoot },
      );
      if (remove.exitCode !== 0) {
        const errText =
          remove.stderr.trim() ||
          remove.stdout.trim() ||
          "git worktree remove failed";
        return errorResult(`Failed to remove worktree: ${errText}`);
      }

      // Clean up the per-session branch if we created one. `git
      // worktree remove --force` does NOT delete the branch.
      if (session.worktreeBranch !== undefined) {
        await runCommand(
          "git",
          [
            "-C",
            session.mainRepoRoot,
            "branch",
            "-D",
            session.worktreeBranch,
          ],
          { cwd: session.mainRepoRoot },
        ).catch(() => {
          /* best-effort branch cleanup */
        });
      }

      setCurrentWorktreeSession(sessionId, null);

      const discardParts: string[] = [];
      if (finalSummary.commits > 0) {
        discardParts.push(
          `${finalSummary.commits} ${finalSummary.commits === 1 ? "commit" : "commits"}`,
        );
      }
      if (finalSummary.changedFiles > 0) {
        discardParts.push(
          `${finalSummary.changedFiles} uncommitted ${finalSummary.changedFiles === 1 ? "file" : "files"}`,
        );
      }
      const discardNote =
        discardParts.length > 0
          ? ` Discarded ${discardParts.join(" and ")}.`
          : "";
      const message = `Exited and removed worktree at ${session.worktreePath}.${discardNote} Session is now back in ${session.originalCwd}.`;
      return okResult(
        {
          action: "remove",
          originalCwd: session.originalCwd,
          worktreePath: session.worktreePath,
          worktreeBranch: session.worktreeBranch,
          discardedFiles: finalSummary.changedFiles,
          discardedCommits: finalSummary.commits,
          message,
        },
        message,
      );
    },
  };
}

/**
 * Test-only helper: clear the in-memory worktree-session map.
 * Vitest fixtures call this in `afterEach` to keep tests isolated.
 */
export function __resetWorktreeSessionsForTesting(): void {
  worktreeSessions.clear();
}

// Avoid unused-import lint when safeStringify isn't referenced in this
// module's surface — keeps the import shape consistent with sibling
// tools (errorResult/okResult format the response).
void safeStringify;
