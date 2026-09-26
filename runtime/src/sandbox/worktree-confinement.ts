/**
 * The write boundary of a subagent isolated in a git worktree.
 *
 * Worktree isolation exists so the checkout the worktree was made from does
 * not change: the verified-change workflow (Goal) builds every change in
 * `<checkout>/.agenc-worktrees/<run>` and promises that the user's checkout
 * is never mutated. A child's commands inherited the parent's sandbox
 * authority, whose writable roots include the parent's workspace, that is
 * the checkout itself. So a worktree child's command sandbox writes only
 * inside its worktree and the temp root its commands get as TMPDIR (the
 * session temp root, or a routine run's scratch folder). Every other write
 * grant is dropped, nothing is added, and reads stay as they are.
 */

import path from "node:path";

import {
  canonicalAuthorityPath,
  isWithinAuthorityPath,
} from "./desktop-authority-protection.js";
import {
  resolvePermissionPath,
  restrictedFileSystemPolicy,
  type FileSystemSandboxEntry,
  type PermissionProfile,
} from "./engine/index.js";

export interface WorktreeWriteConfinement {
  /** The worktree the child works in: the only project directory it writes. */
  readonly worktree: string;
  /** The checkout the worktree isolates. It stays read-only, even under the temp root. */
  readonly checkout: string;
}

/** Options for a forked sandbox authority. */
export interface SandboxForkOptions {
  /**
   * Confine the fork's command writes to a worktree. Absent, a fork keeps its
   * parent's confinement; null drops it, for the runtime's own Git work on the
   * repository (creating and removing a nested worktree), never a command.
   */
  readonly worktreeConfinement?: WorktreeWriteConfinement | null;
}

/** What an unrestricted profile narrows to: workspace-write over the worktree. */
const WORKSPACE_WRITE_ENTRIES: readonly FileSystemSandboxEntry[] = [
  { path: { kind: "special", value: { kind: "root" } }, access: "read" },
  { path: { kind: "special", value: { kind: "project_roots" } }, access: "write" },
  { path: { kind: "special", value: { kind: "tmpdir" } }, access: "write" },
];

function canonical(target: string): string {
  try {
    return canonicalAuthorityPath(target);
  } catch {
    return target;
  }
}

/**
 * A permission profile whose writes stay inside the worktree and the temp
 * root. `sandboxPolicyCwd` is where the profile's project root resolves: the
 * worktree, for a worktree child.
 */
export function confineProfileToWorktree(
  profile: PermissionProfile,
  confinement: WorktreeWriteConfinement,
  sandboxPolicyCwd: string,
  tempRoot: string,
): PermissionProfile {
  const fileSystem = profile.fileSystem;
  const restricted = fileSystem.kind === "restricted";
  const worktree = canonical(confinement.worktree);
  const checkout = canonical(confinement.checkout);
  const temp = canonical(tempRoot);
  // A temp folder inside the checkout (a routine run's scratch folder) is
  // still where commands are told to write; a checkout inside the temp root
  // (a project under /tmp) is not scratch space.
  const tempInsideCheckout = isWithinAuthorityPath(temp, checkout);
  let checkoutUnderKeptRoot = false;
  const others: FileSystemSandboxEntry[] = [];
  const writes: { readonly entry: FileSystemSandboxEntry; readonly depth: number }[] = [];
  for (const entry of restricted ? fileSystem.entries : WORKSPACE_WRITE_ENTRIES) {
    if (entry.access !== "write") {
      others.push(entry);
      continue;
    }
    const target = resolvePermissionPath(entry.path, sandboxPolicyCwd, tempRoot);
    if (target === null) continue;
    const resolved = canonical(target);
    if (!isWithinAuthorityPath(resolved, worktree)) {
      if (!isWithinAuthorityPath(resolved, temp)) continue;
      if (!tempInsideCheckout && isWithinAuthorityPath(resolved, checkout)) continue;
      if (resolved !== checkout && isWithinAuthorityPath(checkout, resolved)) {
        checkoutUnderKeptRoot = true;
      }
    }
    writes.push({ entry, depth: resolved.split(path.sep).length });
  }
  // The temp root holds the checkout: the checkout gets its own read-only
  // entry, and the worktree inside it stays writable because the more
  // specific entry decides. bwrap mounts writable roots in entry order, so
  // a root comes before the roots nested in it.
  const carveout: readonly FileSystemSandboxEntry[] = checkoutUnderKeptRoot
    ? [{ path: { kind: "path", path: checkout }, access: "read" }]
    : [];
  const kept = [
    ...others,
    ...writes.sort((left, right) => left.depth - right.depth).map(({ entry }) => entry),
    ...carveout,
  ];
  const includePlatformDefaults = restricted ? fileSystem.includePlatformDefaults : true;
  return {
    ...profile,
    fileSystem: restrictedFileSystemPolicy(kept, {
      ...(fileSystem.globScanMaxDepth !== undefined
        ? { globScanMaxDepth: fileSystem.globScanMaxDepth }
        : {}),
      ...(includePlatformDefaults !== undefined ? { includePlatformDefaults } : {}),
      ...(fileSystem.reservedReadOnlyPaths !== undefined
        ? { reservedReadOnlyPaths: fileSystem.reservedReadOnlyPaths }
        : {}),
    }),
  };
}
