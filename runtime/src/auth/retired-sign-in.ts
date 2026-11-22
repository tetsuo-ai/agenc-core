/**
 * The AgenC account sign-in is retired. A home that signed in with an older
 * Core still holds that session: `auth.json` (the account details, and in
 * very old homes the session token itself) and the session token in native
 * secure storage (`remoteAuth`, or `localAuth.login` for the local backend).
 * The daemon removes them once, at startup, and never prints them.
 *
 * Core only ever used a stored token when `auth.json` matched it, and signing
 * out removed both. So `auth.json` says whether a home may still hold a
 * session: without it this never opens secure storage, which starts a helper
 * process on macOS and Linux. `auth.json` is removed last, so a failed step is
 * tried again at the next start.
 *
 * @module
 */

import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { HomeContext } from "../config/home.js";
import type { SecureStorageData } from "../utils/secureStorage/index.js";
import {
  NativeSecureStorageUnavailableError,
  updateNativeSecureStorage,
} from "../utils/secureStorage/native.js";

/** The retired policy service's cache. It held no credential. */
const RETIRED_POLICY_LIMITS_CACHE = "policy-limits.json";

export interface RetiredSignInCleanup {
  /** Whether the home still held something from the retired sign-in. */
  readonly found: boolean;
  /** Whether nothing from the retired sign-in is left. */
  readonly removed: boolean;
  /** What failed, in order. Never contains a credential value. */
  readonly errors: readonly Error[];
}

/** Remove what the retired AgenC account sign-in stored in this home. */
export function removeRetiredAgenCSignIn(home: HomeContext): RetiredSignInCleanup {
  const errors: Error[] = [];
  const policyCache = join(home.path, RETIRED_POLICY_LIMITS_CACHE);
  const hasPolicyCache = pathExists(policyCache);
  const hasSession = pathExists(home.authPath);
  if (!hasPolicyCache && !hasSession) {
    return { found: false, removed: true, errors };
  }
  if (hasPolicyCache) removePath(policyCache, errors);
  if (!hasSession) {
    return { found: true, removed: errors.length === 0, errors };
  }
  try {
    updateNativeSecureStorage(
      home,
      withoutRetiredSignIn,
      "Native secure storage is unavailable; the retired AgenC sign-in was not removed.",
    );
  } catch (error) {
    // A host without secure storage could never have stored the token.
    if (!(error instanceof NativeSecureStorageUnavailableError)) {
      errors.push(asError(error));
      return { found: true, removed: false, errors };
    }
  }
  removePath(`${home.authPath}.lock`, errors);
  removePath(home.authPath, errors);
  return { found: true, removed: errors.length === 0 && !pathExists(home.authPath), errors };
}

/** Secure storage without the retired sign-in tokens; everything else is kept. */
export function withoutRetiredSignIn(
  current: Readonly<SecureStorageData>,
): SecureStorageData {
  const next: SecureStorageData = { ...current };
  delete next.remoteAuth;
  if (next.localAuth?.login !== undefined) {
    const { login: _retired, ...localAuth } = next.localAuth;
    if (Object.keys(localAuth).length === 0) {
      delete next.localAuth;
    } else {
      next.localAuth = localAuth;
    }
  }
  return next;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Anything but "not there" might still be there.
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

function removePath(path: string, errors: Error[]): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    errors.push(asError(error));
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
