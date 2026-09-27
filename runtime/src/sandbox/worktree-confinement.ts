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
  type FileSystemSandboxPolicy,
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

interface ConfinementRoots {
  readonly worktree: string;
  readonly checkout: string;
  readonly temp: string;
  /**
   * A temp folder inside the checkout (a routine run's scratch folder) is
   * still where commands are told to write; a checkout inside the temp root
   * (a project under /tmp) is not scratch space.
   */
  readonly tempInsideCheckout: boolean;
}

interface KeptWrite {
  readonly entry: FileSystemSandboxEntry;
  readonly resolved: string;
}

function canonical(target: string): string {
  try {
    return canonicalAuthorityPath(target);
  } catch {
    return target;
  }
}

function confinementRoots(
  confinement: WorktreeWriteConfinement,
  tempRoot: string,
): ConfinementRoots {
  const checkout = canonical(confinement.checkout);
  const temp = canonical(tempRoot);
  return {
    worktree: canonical(confinement.worktree),
    checkout,
    temp,
    tempInsideCheckout: isWithinAuthorityPath(temp, checkout),
  };
}

/** A write grant stays when it is inside the worktree, or inside the temp root and not the checkout. */
function keepsWriteGrant(resolved: string, roots: ConfinementRoots): boolean {
  if (isWithinAuthorityPath(resolved, roots.worktree)) return true;
  if (!isWithinAuthorityPath(resolved, roots.temp)) return false;
  return roots.tempInsideCheckout || !isWithinAuthorityPath(resolved, roots.checkout);
}

/** A kept write grant above the checkout: the temp root of a project under /tmp. */
function holdsCheckout(resolved: string, checkout: string): boolean {
  return resolved !== checkout && isWithinAuthorityPath(checkout, resolved);
}

function depth(target: string): number {
  return target.split(path.sep).length;
}

/** The policy options a confined profile keeps from the profile it narrows. */
function confinedPolicyOptions(
  fileSystem: FileSystemSandboxPolicy,
): Parameters<typeof restrictedFileSystemPolicy>[1] {
  const includePlatformDefaults = fileSystem.kind === "restricted"
    ? fileSystem.includePlatformDefaults
    : true;
  return {
    ...(fileSystem.globScanMaxDepth !== undefined
      ? { globScanMaxDepth: fileSystem.globScanMaxDepth }
      : {}),
    ...(includePlatformDefaults !== undefined ? { includePlatformDefaults } : {}),
    ...(fileSystem.reservedReadOnlyPaths !== undefined
      ? { reservedReadOnlyPaths: fileSystem.reservedReadOnlyPaths }
      : {}),
  };
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
  const roots = confinementRoots(confinement, tempRoot);
  const others: FileSystemSandboxEntry[] = [];
  const writes: KeptWrite[] = [];
  const entries = fileSystem.kind === "restricted" ? fileSystem.entries : WORKSPACE_WRITE_ENTRIES;
  for (const entry of entries) {
    if (entry.access !== "write") {
      others.push(entry);
      continue;
    }
    const target = resolvePermissionPath(entry.path, sandboxPolicyCwd, tempRoot);
    const resolved = target === null ? undefined : canonical(target);
    if (resolved !== undefined && keepsWriteGrant(resolved, roots)) {
      writes.push({ entry, resolved });
    }
  }
  // bwrap mounts writable roots in entry order: a root comes before the
  // roots nested in it, or its bind would cover them.
  const ordered = writes.toSorted((left, right) => depth(left.resolved) - depth(right.resolved));
  // The temp root holds the checkout: the checkout gets its own read-only
  // entry, and the worktree inside it stays writable because the more
  // specific entry decides.
  const carveout: readonly FileSystemSandboxEntry[] =
    ordered.some(({ resolved }) => holdsCheckout(resolved, roots.checkout))
      ? [{ path: { kind: "path", path: roots.checkout }, access: "read" }]
      : [];
  return {
    ...profile,
    fileSystem: restrictedFileSystemPolicy(
      [...others, ...ordered.map(({ entry }) => entry), ...carveout],
      confinedPolicyOptions(fileSystem),
    ),
  };
}
