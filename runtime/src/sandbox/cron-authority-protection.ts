import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { PermissionProfile } from "./engine/index.js";
import { canonicalAuthorityPath, isWithinAuthorityPath, overlapsDesktopAuthority, protectDesktopAuthority } from "./desktop-authority-protection.js";

/** Shared across AGENC_HOME, HOME, and session environments for one OS user. */
export function cronLockAuthorityRoot(osHome = userInfo().homedir): string {
  if (!isAbsolute(osHome)) throw new Error("Cron lock authority requires an absolute OS home");
  const home = canonicalAuthorityPath(osHome);
  // A dedicated namespace avoids depending on an existing, possibly linked,
  // ~/.agenc. Storage validates this root only when durable I/O is requested.
  return join(home, ".agenc-cron-locks-v1");
}

export function overlapsCronAuthority(target: string, root: string): boolean {
  const lexical = resolve(target);
  return isWithinAuthorityPath(lexical, root) || isWithinAuthorityPath(root, lexical) ||
    overlapsDesktopAuthority(target, root);
}

/** The existing non-grantable reservation also protects ancestor replacement. */
export function protectCronAuthority(
  profile: PermissionProfile,
  root = cronLockAuthorityRoot(),
): PermissionProfile {
  return protectDesktopAuthority(profile, root);
}
