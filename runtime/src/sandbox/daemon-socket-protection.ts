import { basename, dirname, join } from "node:path";
import { agenCDaemonFallbackDirectory } from "../../../packages/agenc-sdk/lib/local-endpoint.mjs";
import { canonicalAuthorityPath, protectDesktopAuthority } from "./desktop-authority-protection.js";
import type { PermissionProfile } from "./engine/index.js";

export function daemonSocketAuthorityRoots(): readonly string[] {
  const directory = agenCDaemonFallbackDirectory();
  // Canonicalize /tmp (an alias on macOS), but reserve the directory name even
  // if an unsafe fallback already exists. Endpoint creation validates it.
  return directory === undefined ? [] : [
    join(canonicalAuthorityPath(dirname(directory)), basename(directory)),
  ];
}

export function protectDaemonSocket(profile: PermissionProfile): PermissionProfile {
  return daemonSocketAuthorityRoots().reduce(
    (protectedProfile, root) => protectDesktopAuthority(protectedProfile, root), profile,
  );
}
