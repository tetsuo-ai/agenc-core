import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { PersistedWorktreeSession } from "../types/logs.js";
import {
  _resetGitWorktreeMutationLocksForTesting,
  captureBaseCommit,
  findGitRoot,
  getOrCreateWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
  validateWorktreeSlug,
  withGitWorktreeMutationLock,
  worktreeBranchName,
  type GetOrCreateOpts,
} from "../agents/worktree.js";

export type WorktreeSession = PersistedWorktreeSession & {
  creationDurationMs?: number;
  usedSparsePaths?: boolean;
};

let currentWorktreeSession: WorktreeSession | null = null;

function unsupported(name: string): Error {
  return new Error(`${name} is not implemented in the AgenC runtime port`);
}

function runProcess(
  command: string,
  args: ReadonlyArray<string>,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(command, [...args], { stdio: "ignore" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession;
}

export function restoreWorktreeSession(
  session: WorktreeSession | null,
): void {
  currentWorktreeSession = session;
}

export async function keepWorktree(): Promise<void> {
  currentWorktreeSession = null;
}

export async function cleanupWorktree(): Promise<void> {
  const session = currentWorktreeSession;
  if (!session) {
    return;
  }

  if (!session.worktreeBranch) {
    throw new Error(
      `cannot remove worktree ${session.worktreePath}: worktreeBranch is missing`,
    );
  }

  const gitRoot = findGitRoot(session.worktreePath) ?? findGitRoot(session.originalCwd);
  if (!gitRoot) {
    throw new Error(
      `cannot resolve canonical git root for worktree ${session.worktreePath}`,
    );
  }

  await removeAgentWorktree({
    path: session.worktreePath,
    branch: session.worktreeBranch,
    gitRoot,
  });
  currentWorktreeSession = null;
}

export function generateTmuxSessionName(
  repoPath: string,
  branch: string,
): string {
  return `${basename(repoPath)}_${branch}`.replace(/[/.]/g, "_");
}

export async function isTmuxAvailable(): Promise<boolean> {
  return (await runProcess("tmux", ["-V"])) === 0;
}

export function getTmuxInstallInstructions(): string {
  if (process.platform === "darwin") {
    return "Install tmux with `brew install tmux`.";
  }
  if (process.platform === "linux") {
    return "Install tmux with your package manager, for example `apt install tmux`.";
  }
  return "Install tmux and ensure it is available on PATH.";
}

export async function killTmuxSession(sessionName: string): Promise<void> {
  await runProcess("tmux", ["kill-session", "-t", sessionName]);
}

export async function createAgentWorktree(
  slug: string,
  opts: Omit<GetOrCreateOpts, "gitRoot" | "slug"> = {},
): Promise<{
  worktreePath: string;
  worktreeBranch: string;
  headCommit: string | null;
  existed: boolean;
}> {
  validateWorktreeSlug(slug);
  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) {
    throw new Error("worktree creation requested outside a git repository");
  }

  const handle = await getOrCreateWorktree({
    gitRoot,
    slug,
    ...opts,
  });

  return {
    worktreePath: handle.path,
    worktreeBranch: handle.branch,
    headCommit: await captureBaseCommit(gitRoot),
    existed: !handle.created,
  };
}

export async function cleanupStaleAgentWorktrees(): Promise<number> {
  throw unsupported("cleanupStaleAgentWorktrees");
}

export async function copyWorktreeIncludeFiles(): Promise<ReadonlyArray<string>> {
  throw unsupported("copyWorktreeIncludeFiles");
}

export async function createTmuxSessionForWorktree(): Promise<never> {
  throw unsupported("createTmuxSessionForWorktree");
}

export async function createWorktreeForSession(): Promise<never> {
  throw unsupported("createWorktreeForSession");
}

export async function execIntoTmuxWorktree(): Promise<never> {
  throw unsupported("execIntoTmuxWorktree");
}

export function parsePRReference(): never {
  throw unsupported("parsePRReference");
}

export {
  _resetGitWorktreeMutationLocksForTesting,
  hasWorktreeChanges,
  removeAgentWorktree,
  validateWorktreeSlug,
  withGitWorktreeMutationLock,
  worktreeBranchName,
};
