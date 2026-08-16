/**
 * Landlock confinement planning for the Linux sandbox helper.
 *
 * When bubblewrap is unusable (not installed, or unprivileged user
 * namespaces restricted by AppArmor), the helper can confine through
 * `agenc-landlock-run` instead: a pure kernel allow-list needing no
 * namespaces, plus the same classic-BPF network filter bwrap applies.
 *
 * Landlock can express strictly LESS than bubblewrap — it is an allow-list
 * with no mounts, no masking, and no namespaces — so this module's first
 * job is refusing what it cannot express, loudly, instead of running with a
 * weaker profile than the caller asked for:
 *
 * - **Unreadable masks**: bwrap hides `unreadable` roots/globs by mounting
 *   over them. An allow-list cannot deny inside an allowed subtree, so any
 *   unreadable entry (outside /proc and /sys, which are never granted)
 *   refuses the fallback.
 * - **Read-only carve-outs inside writable roots** (`readOnlySubpaths`) and
 *   **protected metadata** monitoring: deny-inside-allow again; refused.
 * - **Managed proxy networking**: needs a network namespace; refused.
 * - **Inherited read-only cwd**: bound by descriptor under bwrap; refused.
 *
 * `mountProc` is deliberately NOT a refusal: under bubblewrap it mounts a
 * PRIVATE procfs as an environment convenience, and without namespaces the
 * fallback simply provides no /proc at all -- strictly more closed, with
 * /proc-dependent commands failing visibly instead of silently.
 *
 * /proc and /sys are NEVER granted, even under full-disk-read policies.
 * Without a pid namespace, host /proc would expose same-uid process state —
 * `/proc/<pid>/environ` of the daemon carries provider credentials — so the
 * fallback trades /proc-dependent commands (they fail visibly with EACCES)
 * for keeping that channel closed.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";

import {
  getReadableRootsWithCwd,
  getUnreadableGlobsWithCwd,
  getUnreadableRootsWithCwd,
  getWritableRootsWithCwd,
  hasFullDiskReadAccess,
  includePlatformDefaults,
  type FileSystemSandboxPolicy,
} from "../engine/index.js";

/** Root directories never granted, whatever the policy says. */
const NEVER_GRANTED_ROOTS = new Set(["/proc", "/sys"]);

/**
 * Character devices commands routinely open for write (`> /dev/null`, PTY
 * allocation). bwrap provides them through a fresh minimal devtmpfs; the
 * fallback grants exactly these, and a file grant keeps only file-compatible
 * access bits, so a device grant cannot leak directory-level access.
 */
const STANDARD_DEVICE_GRANTS = [
  "/dev/null",
  "/dev/zero",
  "/dev/full",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
  "/dev/ptmx",
  "/dev/pts",
];

export interface LandlockPlanInput {
  readonly fileSystem: FileSystemSandboxPolicy;
  readonly sandboxPolicyCwd: string;
  readonly allowNetworkForProxy: boolean;
  readonly inheritedCwd: boolean;
  readonly extraReadOnlyBindRoots?: readonly string[];
  readonly extraDeviceBindPaths?: readonly string[];
}

export type LandlockPlan =
  | {
      readonly kind: "ok";
      readonly readOnly: readonly string[];
      readonly readWrite: readonly string[];
      /**
       * Protected metadata paths that do not exist yet: enforcement cannot
       * subtract them from a writable subtree, so their CREATION is watched
       * by the same protected-create monitor the bubblewrap path uses, and
       * a run that creates one fails.
       */
      readonly protectedCreateTargets: readonly string[];
    }
  | { readonly kind: "refused"; readonly reason: string };

function underNeverGranted(target: string): boolean {
  return [...NEVER_GRANTED_ROOTS].some(
    (root) => target === root || target.startsWith(`${root}/`),
  );
}

/**
 * Grant the read side of full disk access by enumerating the filesystem
 * root's entries instead of granting `/` itself: this is what keeps /proc
 * and /sys out of the allow-list while everything else stays readable.
 */
function enumeratedRootGrants(): string[] {
  const grants: string[] = [];
  for (const entry of fs.readdirSync("/")) {
    const absolute = `/${entry}`;
    if (NEVER_GRANTED_ROOTS.has(absolute)) continue;
    grants.push(absolute);
  }
  return grants;
}

export function planLandlockConfinement(input: LandlockPlanInput): LandlockPlan {
  if (input.allowNetworkForProxy) {
    return {
      kind: "refused",
      reason: "managed proxy networking requires a network namespace",
    };
  }
  if (input.inheritedCwd) {
    return {
      kind: "refused",
      reason: "inherited read-only cwd requires descriptor binds",
    };
  }

  const policy = input.fileSystem;
  const cwd = input.sandboxPolicyCwd;

  const unreadable = [
    ...getUnreadableRootsWithCwd(policy, cwd),
    // Globs are patterns over host state; whether they match anything NOW
    // says nothing about the confined command's lifetime, so their presence
    // alone refuses (matching bwrap's mask-at-launch would be a race).
    ...getUnreadableGlobsWithCwd(policy, cwd),
  ].filter((target) => !underNeverGranted(target));
  if (unreadable.length > 0) {
    return {
      kind: "refused",
      reason:
        "the policy hides paths from reads, which an allow-list cannot express: " +
        unreadable.slice(0, 3).join(", "),
    };
  }

  const writableRoots = getWritableRootsWithCwd(policy, cwd);
  const protectedCreateTargets: string[] = [];
  for (const root of writableRoots) {
    // Landlock rulesets compose by union along the path hierarchy: a grant
    // on the root covers its whole subtree, and nothing can subtract a
    // child. An EXISTING protected subpath (a real .git under a writable
    // workspace) therefore cannot be kept read-only, and running without
    // that protection would let a confined command rewrite hooks that
    // execute unconfined later -- refuse. A subpath that does not exist yet
    // has nothing to protect from writes; its creation is watched instead.
    for (const subpath of root.readOnlySubpaths) {
      if (fs.existsSync(subpath)) {
        return {
          kind: "refused",
          reason:
            "a writable root carries an existing read-only subpath, which " +
            `an allow-list cannot express: ${subpath}`,
        };
      }
      protectedCreateTargets.push(subpath);
    }
    for (const name of root.protectedMetadataNames ?? []) {
      const target = path.join(root.root, name);
      if (fs.existsSync(target)) {
        return {
          kind: "refused",
          reason:
            "a writable root carries existing protected metadata, which " +
            `an allow-list cannot express: ${target}`,
        };
      }
      protectedCreateTargets.push(target);
    }
  }

  const readOnly = new Set<string>();
  if (hasFullDiskReadAccess(policy)) {
    for (const grant of enumeratedRootGrants()) readOnly.add(grant);
  } else {
    if (includePlatformDefaults(policy)) {
      for (const root of [
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/usr",
        "/etc",
        "/nix/store",
        "/run/current-system/sw",
      ]) {
        if (fs.existsSync(root)) readOnly.add(root);
      }
    }
    for (const root of getReadableRootsWithCwd(policy, cwd)) {
      if (underNeverGranted(root)) continue;
      if (fs.existsSync(root)) readOnly.add(root);
    }
  }
  for (const root of input.extraReadOnlyBindRoots ?? []) {
    if (underNeverGranted(root)) continue;
    if (fs.existsSync(root)) readOnly.add(root);
  }

  const readWrite = new Set<string>();
  for (const root of writableRoots) {
    readWrite.add(root.root);
  }
  for (const device of STANDARD_DEVICE_GRANTS) {
    if (fs.existsSync(device)) readWrite.add(device);
  }
  for (const device of input.extraDeviceBindPaths ?? []) {
    if (fs.existsSync(device)) readWrite.add(device);
  }

  // A grant that is a strict child of another grant on the same side is
  // redundant; keep the argv short and the audit reviewable.
  const compact = (grants: Set<string>): string[] => {
    const sorted = [...grants].sort();
    const kept: string[] = [];
    for (const grant of sorted) {
      if (kept.some((parent) => grant === parent || grant.startsWith(`${parent}${path.sep}`))) {
        continue;
      }
      kept.push(grant);
    }
    return kept;
  };

  return {
    kind: "ok",
    readOnly: compact(readOnly),
    readWrite: compact(readWrite),
    protectedCreateTargets: [...new Set(protectedCreateTargets)],
  };
}
