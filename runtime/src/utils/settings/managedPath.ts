import { dirname, join, win32 } from "node:path";

import {
  getCanonicalSettingsAuthority,
  type CanonicalSettingsAuthority,
} from "./canonicalAuthority.js";

export interface ManagedPathEnvironment {
  readonly ProgramData?: string;
  readonly AGENC_MANAGED_INSTRUCTIONS?: string;
  readonly [key: string]: string | undefined;
}

export interface ManagedPathContext {
  readonly root: string;
  readonly instructions: string;
  readonly rules: string;
}

function joinManagedPath(
  platform: NodeJS.Platform,
  ...parts: readonly string[]
): string {
  return platform === "win32" ? win32.join(...parts) : join(...parts);
}

function dirnameManagedPath(
  platform: NodeJS.Platform,
  path: string,
): string {
  return platform === "win32" ? win32.dirname(path) : dirname(path);
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

/** Resolve the managed instruction file from one captured environment. */
export function resolveManagedInstructionPath(
  env: ManagedPathEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  managedRootPath: string = resolveManagedRootPath(env, platform),
): string {
  return env.AGENC_MANAGED_INSTRUCTIONS ??
    joinManagedPath(platform, managedRootPath, "AGENC.md");
}

/** Managed instruction rules always live beside the selected instruction file. */
export function resolveManagedInstructionRulesPath(
  instructionPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return joinManagedPath(
    platform,
    dirnameManagedPath(platform, instructionPath),
    "rules",
  );
}

/** Capture every managed Markdown path from one environment and platform. */
export function resolveManagedPathContext(
  env: ManagedPathEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  managedRootPath: string = resolveManagedRootPath(env, platform),
): ManagedPathContext {
  const instructions = resolveManagedInstructionPath(
    env,
    platform,
    managedRootPath,
  );
  return Object.freeze({
    root: managedRootPath,
    instructions,
    rules: resolveManagedInstructionRulesPath(instructions, platform),
  });
}

function requireManagedPathAuthority(
  authority: CanonicalSettingsAuthority | null,
): CanonicalSettingsAuthority {
  if (authority === null) {
    throw new Error("Managed path resolution requires a ConfigStore authority");
  }
  return authority;
}

/**
 * Get the managed assets root captured by the active ConfigStore.
 */
export function getManagedFilePath(
  authority: CanonicalSettingsAuthority | null =
    getCanonicalSettingsAuthority(),
): string {
  return requireManagedPathAuthority(authority).managedPaths.root;
}

/** Get the managed instruction file captured by the active ConfigStore. */
export function getManagedInstructionPath(
  authority: CanonicalSettingsAuthority | null =
    getCanonicalSettingsAuthority(),
): string {
  return requireManagedPathAuthority(authority).managedPaths.instructions;
}

/** Get the adjacent managed instruction-rules directory. */
export function getManagedInstructionRulesPath(
  authority: CanonicalSettingsAuthority | null =
    getCanonicalSettingsAuthority(),
): string {
  return requireManagedPathAuthority(authority).managedPaths.rules;
}
