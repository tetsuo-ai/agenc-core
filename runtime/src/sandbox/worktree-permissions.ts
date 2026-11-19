import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { findCanonicalGitRoot } from "../utils/git.js";
import { canonicalAuthorityPath } from "./desktop-authority-protection.js";
import type { AdditionalPermissionProfile } from "./engine/index.js";

/**
 * Narrow filesystem grants required by a controlled `git worktree` mutation.
 * The ordinary workspace-write profile deliberately protects `.git` and
 * `.agenc`; only typed worktree operations should opt into these paths.
 */
export function worktreeMutationPermissions(
  repoRoot: string,
  writablePaths: readonly string[] = [],
): AdditionalPermissionProfile {
  const metadataRoot = worktreeMutationMetadataRoot(repoRoot);
  const entries = [metadataRoot, ...writablePaths.map((entry) => resolve(entry))]
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .map((path) => ({
      path: { kind: "path" as const, path },
      access: "write" as const,
    }));
  return { fileSystem: { entries } };
}

/**
 * The `.git` pointer file of the linked worktree at `worktreePath`, as an
 * extra write path for the two Core-run git commands that create it
 * (`git worktree add`) and delete it (`git worktree remove`). Empty off macOS.
 *
 * The macOS seatbelt profile is static: below every writable root it refuses
 * any `.git` entry, so a command cannot plant a nested repository or a gitfile
 * pointer that a later host-side git would follow. A linked worktree's own
 * pointer is such an entry, and macOS has no created-path monitor to tell it
 * apart, so `git worktree add` died with "could not open '<worktree>/.git' for
 * writing: Operation not permitted" and every Goal run and worktree-isolated
 * agent failed there. These two commands therefore name this one file. The
 * grant never reaches a command the model runs: those still cannot create,
 * rewrite or remove a `.git` anywhere.
 *
 * Linux needs no grant and must not get one. Its created-path monitor accepts
 * a pointer into the protected `.git/worktrees`, and its launcher would turn
 * the missing pointer into a directory before `git worktree add` and refuses
 * the existing one before `git worktree remove`.
 *
 * The parent is spelled physically because the pointer does not exist when it
 * is created, and the seatbelt profile matches physical paths.
 */
export function linkedWorktreePointerPaths(
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "darwin") return [];
  return [join(canonicalAuthorityPath(worktreePath), ".git")];
}

/** The Git metadata directory a worktree mutation of `repoRoot` may write. */
export function worktreeMutationMetadataRoot(repoRoot: string): string {
  const resolvedRepoRoot = resolve(repoRoot);
  return resolveGitMetadataRoot(
    findCanonicalGitRoot(resolvedRepoRoot) ?? resolvedRepoRoot,
  );
}

export function resolveGitMetadataRoot(canonicalRoot: string): string {
  const root = resolve(canonicalRoot);
  if (basename(root) === ".git" || isBareGitCommonDirectory(root)) return root;
  return join(root, ".git");
}

/**
 * Checkout/materialization must not inherit a write grant to the common Git
 * directory. A repository-configured smudge/process filter runs as Git's child
 * and would inherit that grant. Restrict the second phase to the new linked
 * worktree's own admin directory and working tree.
 */
export function worktreeCheckoutPermissions(
  repoRoot: string,
  worktreePath: string,
): AdditionalPermissionProfile {
  const metadataRoot = realpathSync(
    resolveGitMetadataRoot(findCanonicalGitRoot(resolve(repoRoot)) ?? resolve(repoRoot)),
  );
  const dotGit = join(resolve(worktreePath), ".git");
  const pointer = readFileSync(dotGit, "utf8").trim();
  if (!pointer.startsWith("gitdir:")) {
    throw new Error(`linked worktree has no gitdir pointer: ${dotGit}`);
  }
  const adminDir = realpathSync(
    resolve(worktreePath, pointer.slice("gitdir:".length).trim()),
  );
  const worktreesRoot = realpathSync(join(metadataRoot, "worktrees"));
  if (dirname(adminDir) !== worktreesRoot) {
    throw new Error(
      `linked worktree admin directory escapes common metadata: ${adminDir}`,
    );
  }
  const commonDir = realpathSync(
    resolve(adminDir, readFileSync(join(adminDir, "commondir"), "utf8").trim()),
  );
  if (commonDir !== metadataRoot) {
    throw new Error(
      `linked worktree common metadata mismatch: ${commonDir}`,
    );
  }
  return {
    fileSystem: {
      entries: [adminDir, resolve(worktreePath)].map((path) => ({
        path: { kind: "path" as const, path },
        access: "write" as const,
      })),
    },
  };
}

function isBareGitCommonDirectory(root: string): boolean {
  try {
    return (
      existsSync(join(root, "HEAD")) &&
      statSync(join(root, "HEAD")).isFile() &&
      statSync(join(root, "objects")).isDirectory() &&
      statSync(join(root, "refs")).isDirectory()
    );
  } catch {
    return false;
  }
}

/**
 * Disable repository-controlled helpers and optional background maintenance.
 * A controlled Git transaction must not outlive its supervised command by
 * detaching automatic maintenance after an otherwise successful commit.
 */
export function hardenGitWorktreeMutationArgs(
  args: readonly string[],
): string[] {
  const emptyHooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
  return [
    "-c",
    `core.hooksPath=${emptyHooksPath}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "diff.external=",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    ...args,
  ];
}
