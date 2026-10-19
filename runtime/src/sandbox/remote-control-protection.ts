import { join } from "node:path";
import { resolveHomeContext } from "../config/home.js";
import { getCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import { resolveManagedRootPath } from "../utils/settings/managedPath.js";
import type { PermissionProfile } from "./engine/policy.js";
import { overlapsDesktopAuthority, protectDesktopAuthority } from "./desktop-authority-protection.js";

/** Capture from the host/session authority, never a tool's supplied environment. */
export function remoteControlAuthorityPaths(
  home?: string,
  managedRoot?: string,
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const authority = getCanonicalSettingsAuthority();
  const root = home ?? authority?.homeContext.path ?? resolveHomeContext(environment).path;
  const managed = managedRoot ?? authority?.managedPaths.root ?? resolveManagedRootPath(environment);
  // Reserve the whole managed root, including missing future drop-ins and
  // their parent. A missing file reservation cannot safely anchor a missing
  // managed directory under a broad write grant.
  return [join(root, "config.toml"), managed];
}

export function isRemoteControlAuthorityPath(target: string): boolean {
  return remoteControlAuthorityPaths().some(root => overlapsDesktopAuthority(target, root));
}

/** Non-grantable reservations survive additional write roots and permission changes. */
export function protectRemoteControlAuthority(
  profile: PermissionProfile,
  paths: readonly string[] = remoteControlAuthorityPaths(),
): PermissionProfile {
  return paths.reduce((current, root) => protectDesktopAuthority(current, root), profile);
}
