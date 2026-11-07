import { resolveHomeContext } from "../config/home.js";
import { getWritableRootPathsWithCwd, type PermissionProfile } from "./engine/policy.js";
import {
  canonicalAuthorityPath,
  isWithinAuthorityPath,
  protectDesktopAuthority,
} from "./desktop-authority-protection.js";

/** An ambient temp/workspace grant must not make the containing agent home writable. */
export function protectAgencHomeUnderWritableRoot(
  profile: PermissionProfile,
  home: string,
  cwd: string,
  sessionTempRoot: string,
  grantedProfile: PermissionProfile = profile,
): PermissionProfile {
  const canonicalHome = canonicalAuthorityPath(home);
  // Only the writable root paths decide this, so their read-only carve-outs
  // (and the nested-repository walk behind them) are not computed here: this
  // runs for every tool call.
  const containsHome = getWritableRootPathsWithCwd(grantedProfile.fileSystem, cwd, sessionTempRoot)
    .some((root) => isWithinAuthorityPath(canonicalHome, canonicalAuthorityPath(root)));
  // A separately authorized child, such as a plugin's private data directory,
  // does not grant the rest of home. Preserve that narrower authority.
  return containsHome ? protectDesktopAuthority(profile, canonicalHome) : profile;
}

export function sandboxAgencHome(
  boundHome?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return canonicalAuthorityPath(boundHome ?? resolveHomeContext(environment).path);
}
