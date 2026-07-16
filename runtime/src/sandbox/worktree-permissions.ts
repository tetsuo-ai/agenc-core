import { existsSync, statSync } from "node:fs";
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
  const metadataRoot = resolveGitMetadataRoot(canonicalRoot);
  const entries = [metadataRoot, ...writablePaths.map((entry) => resolve(entry))]
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .map((path) => ({
      path: { kind: "path" as const, path },
      access: "write" as const,
    }));
  return { fileSystem: { entries } };
}

export function resolveGitMetadataRoot(canonicalRoot: string): string {
  const root = resolve(canonicalRoot);
  if (basename(root) === ".git" || isBareGitCommonDirectory(root)) return root;
  return join(root, ".git");
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
    "-c",
    "credential.helper=",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "diff.external=",
    ...args,
  ];
}
