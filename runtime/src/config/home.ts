import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { fileSuffixForOauthConfig } from "../constants/oauth.js";

export const RETIRED_CONFIG_DIR_ENV = "AGENC_CONFIG_DIR" as const;

export interface HomeEnvironment {
  readonly AGENC_HOME?: string;
  readonly AGENC_CONFIG_DIR?: string;
  readonly HOME?: string;
  readonly [key: string]: string | undefined;
}

export type HomeSource = "agenc-home" | "default" | "retired-config-dir";

export interface HomeContext {
  readonly path: string;
  /** Platform-normalized identity used by hashes and equality checks. */
  readonly identityKey: string;
  /** Account component of the native credential record, captured at ingress. */
  readonly secureStorageAccount: string;
  /** OAuth namespace component of the native credential service name. */
  readonly oauthFileSuffix: string;
  readonly source: HomeSource;
  readonly isDefault: boolean;
  readonly configTomlPath: string;
  readonly statePath: string;
  readonly authPath: string;
  readonly trustedProjectsPath: string;
}

export interface ResolveHomeContextOptions {
  readonly platformHome?: string;
  readonly platform?: NodeJS.Platform;
}

export class RetiredConfigDirError extends Error {
  readonly name = "RetiredConfigDirError";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidHomePathError extends Error {
  readonly name = "InvalidHomePathError";
}

export class SecureStorageAccountResolutionError extends Error {
  readonly name = "SecureStorageAccountResolutionError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Canonicalize the home before it participates in daemon identity, locks, or
 * secure-storage service names. Resolve the deepest existing ancestor before
 * appending missing components so creation beneath a symlink cannot change
 * daemon or native secure storage identity on the next launch.
 */
export function canonicalizeHomePath(path: string): string {
  const normalized = path.normalize("NFC");
  if (!isAbsolute(normalized)) {
    throw new InvalidHomePathError(
      `AGENC_HOME must be an absolute path so daemon, lock, and secure-storage identity is stable: ${JSON.stringify(path)}`,
    );
  }
  const missingComponents: string[] = [];
  let existingAncestor = normalized;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new InvalidHomePathError(
        `AGENC_HOME has no resolvable existing ancestor: ${JSON.stringify(path)}`,
      );
    }
    missingComponents.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  if (!statSync(existingAncestor).isDirectory()) {
    throw new InvalidHomePathError(
      `AGENC_HOME must resolve beneath a directory: ${JSON.stringify(path)}`,
    );
  }
  return join(
    realpathSync(existingAncestor),
    ...missingComponents,
  ).normalize("NFC");
}

export function homePathIdentityKey(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = path.normalize("NFC");
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function assertNoRetiredConfigDir(
  env: HomeEnvironment = process.env,
): void {
  if (env.AGENC_CONFIG_DIR === undefined) return;
  const legacy = nonEmpty(env.AGENC_CONFIG_DIR);
  const replacement = legacy === undefined
    ? "set AGENC_HOME to the intended absolute home directory"
    : `set AGENC_HOME=${JSON.stringify(legacy)}`;
  throw new RetiredConfigDirError(
    `AGENC_CONFIG_DIR is no longer a runtime configuration authority; ` +
      `${replacement} and remove AGENC_CONFIG_DIR. ` +
      `Only \"agenc config migrate\" may inspect this retired variable.`,
  );
}

function createHomeContext(
  path: string,
  source: HomeSource,
  defaultPath: string,
  platform: NodeJS.Platform,
  environment: HomeEnvironment,
): HomeContext {
  const canonical = canonicalizeHomePath(path);
  const identityKey = homePathIdentityKey(canonical, platform);
  return Object.freeze({
    path: canonical,
    identityKey,
    secureStorageAccount: resolveSecureStorageAccount(platform),
    oauthFileSuffix: fileSuffixForOauthConfig(environment),
    source,
    isDefault:
      identityKey ===
      homePathIdentityKey(canonicalizeHomePath(defaultPath), platform),
    configTomlPath: join(canonical, "config.toml"),
    statePath: join(canonical, "state.json"),
    authPath: join(canonical, "auth.json"),
    trustedProjectsPath: join(canonical, "trusted-projects.json"),
  });
}

function resolveSecureStorageAccount(platform: NodeJS.Platform): string {
  // DPAPI is already bound to CurrentUser. A fixed account label avoids
  // adding renameable username data to the Windows credential identity.
  if (platform === "win32") return "current-user";

  try {
    // POSIX usernames can change through account rename or NSS. The numeric
    // uid is the durable operating-system account identity. Explicit retired
    // migration alone reconstructs historical username-derived records.
    const uid = userInfo().uid;
    if (!Number.isSafeInteger(uid) || uid < 0) {
      throw new Error(`invalid uid ${JSON.stringify(uid)}`);
    }
    return `uid:${uid}`;
  } catch (cause) {
    throw new SecureStorageAccountResolutionError(
      "Unable to resolve the operating-system account for native secure storage; refusing to construct an unstable credential identity.",
      { cause },
    );
  }
}

/** Resolve the sole normal-runtime home authority: AGENC_HOME. */
export function resolveHomeContext(
  env: HomeEnvironment = process.env,
  options: ResolveHomeContextOptions = {},
): HomeContext {
  assertNoRetiredConfigDir(env);
  const platformHome = options.platformHome ?? homedir();
  const platform = options.platform ?? process.platform;
  const defaultPath = join(platformHome, ".agenc");
  const configured = nonEmpty(env.AGENC_HOME);
  return createHomeContext(
    configured ?? defaultPath,
    configured === undefined ? "default" : "agenc-home",
    defaultPath,
    platform,
    env,
  );
}

/**
 * Migration-only resolver. It may locate a retired home, but it
 * refuses split-brain input rather than assigning precedence to two roots.
 */
export function resolveMigrationHomeContext(
  env: HomeEnvironment = process.env,
  options: ResolveHomeContextOptions = {},
): HomeContext {
  const platformHome = options.platformHome ?? homedir();
  const platform = options.platform ?? process.platform;
  const defaultPath = join(platformHome, ".agenc");
  const configured = nonEmpty(env.AGENC_HOME);
  const legacy = nonEmpty(env.AGENC_CONFIG_DIR);

  if (configured !== undefined && legacy !== undefined) {
    const configuredPath = canonicalizeHomePath(configured);
    const legacyPath = canonicalizeHomePath(legacy);
    if (
      homePathIdentityKey(configuredPath, platform) !==
      homePathIdentityKey(legacyPath, platform)
    ) {
      throw new RetiredConfigDirError(
        `AGENC_HOME (${configuredPath}) and AGENC_CONFIG_DIR (${legacyPath}) ` +
          `resolve to different homes; migration refuses to guess.`,
      );
    }
    return createHomeContext(
      configuredPath,
      "agenc-home",
      defaultPath,
      platform,
      env,
    );
  }

  if (configured !== undefined) {
    return createHomeContext(
      configured,
      "agenc-home",
      defaultPath,
      platform,
      env,
    );
  }
  if (legacy !== undefined) {
    return createHomeContext(
      legacy,
      "retired-config-dir",
      defaultPath,
      platform,
      env,
    );
  }
  return createHomeContext(
    defaultPath,
    "default",
    defaultPath,
    platform,
    env,
  );
}
