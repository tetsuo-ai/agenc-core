import { join, win32 } from "node:path";

import memoize from "lodash-es/memoize.js";

export interface ManagedPathEnvironment {
  readonly ProgramData?: string;
  readonly [key: string]: string | undefined;
}

function joinManagedPath(
  platform: NodeJS.Platform,
  ...parts: readonly string[]
): string {
  return platform === "win32" ? win32.join(...parts) : join(...parts);
}

/** Resolve the machine-wide managed root from one captured environment. */
export function resolveManagedRootPath(
  env: ManagedPathEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  switch (platform) {
    case "darwin":
      return "/Library/Application Support/AgenC";
    case "win32":
      return win32.join(env.ProgramData ?? "C:\\ProgramData", "AgenC");
    default:
      return "/etc/agenc";
  }
}

/** Resolve the canonical machine-wide config file from the same authority. */
export function resolveManagedConfigPath(
  env: ManagedPathEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return joinManagedPath(
    platform,
    resolveManagedRootPath(env, platform),
    "config.toml",
  );
}

/**
 * Get the canonical managed configuration/assets directory.
 */
export const getManagedFilePath = memoize(function (): string {
  return resolveManagedRootPath();
});
