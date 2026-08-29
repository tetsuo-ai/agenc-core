import {
  resolveHomeContext,
  type HomeContext,
  type HomeEnvironment,
} from "../../config/home.js";
import { getCurrentRuntimeSession } from "../../session/current-session.js";
import { getAgenCHomeContext } from "../envUtils.js";
import { getCanonicalSettingsAuthority } from "../settings/canonicalAuthority.js";
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getSecureStorageServiceName,
} from "./macOsKeychainHelpers.js";

export interface SecureStorageIngress {
  /** Complete environment snapshot captured before any asynchronous work. */
  readonly environment: Readonly<HomeEnvironment>;
  /** Native secure storage identity derived from that exact snapshot. */
  readonly home: HomeContext;
}

/**
 * Concrete canonical secure-storage identity for caches and single-flight registries.
 * Service/account is sufficient on Keychain and Secret Service; DPAPI also
 * stores the record below its bound home, so include the normalized path on
 * Windows. Never key credential state by home.path alone: prod, local, and
 * custom OAuth configurations intentionally use distinct native records at
 * the same home.
 */
export function secureStorageIdentityKey(home: HomeContext): string {
  const serviceName = getSecureStorageServiceName(
    home,
    CREDENTIALS_SERVICE_SUFFIX,
  );
  return process.platform === "win32"
    ? `${home.identityKey}\0${serviceName}\0${home.secureStorageAccount}`
    : `${serviceName}\0${home.secureStorageAccount}`;
}

/**
 * Capture the complete process/embedding environment and bind its home once at
 * a real runtime ingress. This is deliberately separate from the session-aware
 * resolver below: a one-shot CLI, gateway, or auth backend must not inherit a
 * concurrently installed session authority, and an explicit home must not
 * discard OAuth namespace inputs such as USE_LOCAL_OAUTH.
 */
export function captureSecureStorageIngress(
  env: HomeEnvironment = process.env,
  explicitHome?: string,
): SecureStorageIngress {
  const environment: Readonly<HomeEnvironment> = Object.freeze({
    ...env,
    ...(explicitHome === undefined ? {} : { AGENC_HOME: explicitHome }),
  });
  const platformHome = nonEmpty(environment.HOME);
  const home = resolveHomeContext(environment, {
    ...(platformHome !== undefined ? { platformHome } : {}),
  });
  return Object.freeze({ environment, home });
}

/**
 * Resolve a native secure storage identity once at the owning runtime boundary. Pass
 * the returned immutable context through every later read/update/rollback;
 * secure-storage adapters must never re-read ambient home variables.
 */
export function resolveSecureStorageHome(
  env: HomeEnvironment = process.env,
  explicitHome?: string,
): HomeContext {
  if (explicitHome === undefined) {
    let activeSession: ReturnType<typeof getCurrentRuntimeSession>;
    try {
      activeSession = getCurrentRuntimeSession();
    } catch {
      return getAgenCHomeContext();
    }
    if (
      activeSession !== null ||
      getCanonicalSettingsAuthority() !== null ||
      env === process.env
    ) {
      return getAgenCHomeContext();
    }
  }
  return captureSecureStorageIngress(env, explicitHome).home;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
