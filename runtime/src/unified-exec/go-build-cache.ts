import { isAbsolute, join } from "node:path";

import {
  canWritePathWithCwd,
  permissionProfileToRuntimePermissions,
  type AdditionalPermissionProfile,
  type PermissionProfile,
} from "../sandbox/engine/index.js";
import { effectivePermissionProfile } from "../sandbox/engine/policy-transforms.js";

/**
 * Go keeps its build cache in GOCACHE, by default the user cache directory
 * (os.UserCacheDir()/go-build). A sandboxed command may write only its
 * workspace, writable roots and the session temp root, so every `go build`,
 * `go test` or `go run` failed with "failed to initialize build cache ...
 * read-only file system" before compiling anything, and the model spent a
 * call working around it.
 *
 * When the cache Go would use is not writable under this command's effective
 * sandbox policy (its profile plus any additional permissions it was granted,
 * merged as the sandbox transform merges them), GOCACHE points at the session
 * temp root instead. Only the build cache moves: module sources (GOMODCACHE)
 * are still read in place, and a GOCACHE the command may write is kept.
 */
export function withWritableGoBuildCache(
  env: Readonly<Record<string, string>>,
  profile: PermissionProfile,
  additionalPermissions: AdditionalPermissionProfile | undefined,
  cwd: string,
  sessionTempRoot: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const policy = permissionProfileToRuntimePermissions(
    effectivePermissionProfile(profile, additionalPermissions),
  ).fileSystem;
  const configured = env.GOCACHE;
  const target = configured !== undefined && configured !== ""
    ? configured
    : defaultGoBuildCache(env, platform);
  if (
    target !== undefined &&
    isAbsolute(target) &&
    canWritePathWithCwd(policy, target, cwd, sessionTempRoot)
  ) {
    return { ...env };
  }
  return { ...env, GOCACHE: join(sessionTempRoot, "go-build") };
}

/** os.UserCacheDir()/go-build for the child's environment, as Go resolves it. */
function defaultGoBuildCache(
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "win32") {
    const localAppData = env.LocalAppData ?? env.LOCALAPPDATA;
    return localAppData !== undefined && localAppData !== ""
      ? join(localAppData, "go-build")
      : undefined;
  }
  const home = env.HOME;
  if (platform === "darwin") {
    return home !== undefined && home !== "" ? join(home, "Library", "Caches", "go-build") : undefined;
  }
  const xdgCacheHome = env.XDG_CACHE_HOME;
  if (xdgCacheHome !== undefined && isAbsolute(xdgCacheHome)) return join(xdgCacheHome, "go-build");
  return home !== undefined && home !== "" ? join(home, ".cache", "go-build") : undefined;
}
