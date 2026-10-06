import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { PermissionProfile } from "./engine/index.js";
import { canonicalAuthorityPath, isWithinAuthorityPath, overlapsDesktopAuthority, protectDesktopAuthority } from "./desktop-authority-protection.js";

const knownAuthorityRoots = new Set<string>();
let unresolvedPolicyAuthority = false;

function resolveCronLockAuthorityRoot(osHome: string): string {
  if (!isAbsolute(osHome)) throw new Error("Cron lock authority requires an absolute OS home");
  const home = canonicalAuthorityPath(osHome);
  // A dedicated namespace avoids depending on an existing, possibly linked,
  // ~/.agenc. Storage validates this root only when durable I/O is requested.
  return join(home, ".agenc-cron-locks-v1");
}

/** Required storage authority, independent of mutable home/session settings. */
export function cronLockAuthorityRoot(osHome?: string): string {
  if (unresolvedPolicyAuthority) {
    throw new Error("Durable cron requires a restart after OS identity recovery: an existing sandbox policy has no trusted cron reservation");
  }
  try {
    const root = resolveCronLockAuthorityRoot(osHome ?? userInfo().homedir);
    knownAuthorityRoots.add(root);
    return root;
  } catch (cause) {
    throw new Error("Cron lock authority unavailable: trusted OS home could not be resolved", { cause });
  }
}

/** Optional policy projection; never infer a trusted namespace from HOME. */
export function cronLockAuthorityRoots(): readonly string[] {
  try {
    knownAuthorityRoots.add(resolveCronLockAuthorityRoot(userInfo().homedir));
  } catch {
    // Preserve every previously verified reservation through lookup failures.
    // If none was available, this process must never later create durable locks
    // under an earlier policy that could not reserve their namespace.
    if (knownAuthorityRoots.size === 0) unresolvedPolicyAuthority = true;
  }
  return [...knownAuthorityRoots];
}

export function overlapsCronAuthority(target: string, root: string): boolean {
  const lexical = resolve(target);
  return isWithinAuthorityPath(lexical, root) || isWithinAuthorityPath(root, lexical) ||
    overlapsDesktopAuthority(target, root);
}

/** The existing non-grantable reservation also protects ancestor replacement. */
export function protectCronAuthority(
  profile: PermissionProfile,
  roots: string | readonly string[] = cronLockAuthorityRoots(),
): PermissionProfile {
  return (typeof roots === "string" ? [roots] : roots).reduce(
    (protectedProfile, root) => protectDesktopAuthority(protectedProfile, root), profile,
  );
}
