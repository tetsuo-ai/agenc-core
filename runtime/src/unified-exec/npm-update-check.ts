import { isAbsolute, join } from "node:path";

import {
  canWritePathWithCwd,
  permissionProfileToRuntimePermissions,
  type AdditionalPermissionProfile,
  type PermissionProfile,
} from "../sandbox/engine/index.js";
import { effectivePermissionProfile } from "../sandbox/engine/policy-transforms.js";

/** npm records its last update check here, inside its cache directory. */
const NPM_UPDATE_CHECK_FILE = "_update-notifier-last-checked";

/**
 * npm checks the registry for a newer npm at most once a week and records
 * the check in `<npm cache>/_update-notifier-last-checked` (the cache is
 * ~/.npm by default, %LocalAppData%\npm-cache on Windows). A sandboxed
 * command may write only its workspace, writable roots and the session temp
 * root, so under a policy that cannot write that file npm never records the
 * check: every `npm` and `npx` run loads npm's registry client and checks
 * again. In a network-denied sandbox the check fails every time, about 60 to
 * 80 ms per run; with the network open it queries the registry on every run
 * and repeats any upgrade notice.
 *
 * When that file is not writable under this command's effective sandbox
 * policy (its profile plus any additional permissions it was granted, merged
 * as the sandbox transform merges them), npm_config_update_notifier=false
 * turns the check off for the command. An update-notifier setting in the
 * environment is kept. npm's cache, configuration and logs are unchanged.
 */
export function withNpmUpdateCheckWhereRecordable(
  env: Readonly<Record<string, string>>,
  profile: PermissionProfile,
  additionalPermissions: AdditionalPermissionProfile | undefined,
  cwd: string,
  sessionTempRoot: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (Object.keys(env).some((key) => key.toLowerCase() === "npm_config_update_notifier")) {
    return { ...env };
  }
  const cache = npmCacheDirectory(env, platform);
  const policy = permissionProfileToRuntimePermissions(
    effectivePermissionProfile(profile, additionalPermissions),
  ).fileSystem;
  if (
    cache !== undefined &&
    isAbsolute(cache) &&
    canWritePathWithCwd(policy, join(cache, NPM_UPDATE_CHECK_FILE), cwd, sessionTempRoot)
  ) {
    return { ...env };
  }
  return { ...env, npm_config_update_notifier: "false" };
}

/** npm's cache directory for the child's environment, as npm resolves its default. */
function npmCacheDirectory(
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): string | undefined {
  const configured = Object.entries(env).find(([key]) => key.toLowerCase() === "npm_config_cache")?.[1];
  if (configured !== undefined && configured !== "") return configured;
  if (platform === "win32") {
    const localAppData = env.LocalAppData ?? env.LOCALAPPDATA;
    return localAppData !== undefined && localAppData !== "" ? join(localAppData, "npm-cache") : undefined;
  }
  const home = env.HOME;
  return home !== undefined && home !== "" ? join(home, ".npm") : undefined;
}
