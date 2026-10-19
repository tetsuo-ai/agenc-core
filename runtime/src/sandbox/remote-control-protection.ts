import { readlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { resolveHomeContext } from "../config/home.js";
import { getCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import { resolveManagedRootPath } from "../utils/settings/managedPath.js";
import type { PermissionProfile } from "./engine/policy.js";
import { canonicalAuthorityPath, overlapsDesktopAuthority, protectDesktopAuthority } from "./desktop-authority-protection.js";

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
  const paths = new Set<string>();
  // The home loader permits a leaf symlink (common with dotfile managers).
  // Protect its source as well as each destination, including a missing leaf.
  let config = join(root, "config.toml");
  for (let depth = 0; depth < 40; depth += 1) {
    paths.add(config);
    paths.add(canonicalAuthorityPath(config));
    let target: string;
    try { target = readlinkSync(config); } catch { break; }
    config = isAbsolute(target) ? target : join(dirname(config), target);
  }
  paths.add(managed);
  paths.add(canonicalAuthorityPath(managed));
  return [...paths];
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
