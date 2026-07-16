import { basename, join, resolve } from "node:path";

import { findCanonicalGitRoot } from "../utils/git.js";
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
  const resolvedRepoRoot = resolve(repoRoot);
  const canonicalRoot = findCanonicalGitRoot(resolvedRepoRoot) ?? resolvedRepoRoot;
  const metadataRoot = basename(canonicalRoot) === ".git"
    ? canonicalRoot
    : join(canonicalRoot, ".git");
  const entries = [metadataRoot, ...writablePaths.map((entry) => resolve(entry))]
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .map((path) => ({
      path: { kind: "path" as const, path },
      access: "write" as const,
    }));
  return { fileSystem: { entries } };
}

/** Disable repository-controlled hooks/fsmonitor for metadata-privileged Git. */
export function hardenGitWorktreeMutationArgs(
  args: readonly string[],
): string[] {
  const emptyHooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
  return [
    "-c",
    `core.hooksPath=${emptyHooksPath}`,
    "-c",
    "core.fsmonitor=false",
    ...args,
  ];
}
