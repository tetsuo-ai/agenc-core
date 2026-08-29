import { execa, execaSync } from "execa";
import { isAbsolute } from "node:path";
import { jsonStringify } from "../slowOperations.js";
import {
  CREDENTIALS_SERVICE_SUFFIX,
  clearKeychainCacheState,
  getKeychainCacheState,
  getMacOsKeychainStorageServiceName,
  KEYCHAIN_CACHE_TTL_MS,
} from "./macOsKeychainHelpers.js";
import type { HomeContext } from "../../config/home.js";
import type { SecureStorage, SecureStorageData } from "./index.js";
import { decodeSecureStorageData } from "./decode.js";
import {
  runSecureStorageCommand,
  type SecureStorageCommandRunner,
  type SecureStorageCommandResult,
} from "./subprocess.js";
import {
  resolveBundledSecureStorageHelper,
  SECURE_STORAGE_HELPER_PAYLOAD_LIMIT_BYTES,
} from "./nativeHelper.js";

const KEYCHAIN_HELPER_NAME = "agenc-keychain-helper";
const INJECTED_KEYCHAIN_HELPER_PATH = "/usr/libexec/agenc-keychain-helper";
const MACOS_SECURITY_PATH = "/usr/bin/security";

function isKeychainItemNotFound(result: {
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly error?: string;
}): boolean {
  return result.exitCode === 2 && !result.stderr?.trim() && !result.error;
}

function decodeKeychainReadResult(
  result: SecureStorageCommandResult,
): SecureStorageData | null {
  if (isKeychainItemNotFound(result)) return null;
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        `macOS Keychain lookup failed with exit code ${result.exitCode}`,
    );
  }
  if (!result.stdout) {
    throw new Error("macOS Keychain returned an empty credential record");
  }
  return decodeSecureStorageData(result.stdout, "macOS Keychain");
}

export function createMacOsKeychainStorage(
  home: HomeContext,
  runCommand: SecureStorageCommandRunner = runSecureStorageCommand,
  serviceNameOverride?: string,
  bypassReadCache = false,
  accountNameOverride?: string,
  resolveExecutable?: () => string,
): SecureStorage {
  const storageServiceName =
    serviceNameOverride ??
    getMacOsKeychainStorageServiceName(home, CREDENTIALS_SERVICE_SUFFIX);
  const username = accountNameOverride ?? home.secureStorageAccount;
  const resolveHelper =
    resolveExecutable ??
    (runCommand === runSecureStorageCommand
      ? () => resolveBundledSecureStorageHelper(KEYCHAIN_HELPER_NAME)
      : () => INJECTED_KEYCHAIN_HELPER_PATH);
  let keychainHelperExecutable: string | undefined;
  const getKeychainHelperExecutable = (): string => {
    keychainHelperExecutable ??= resolveHelper();
    if (!isAbsolute(keychainHelperExecutable)) {
      throw new Error(
        "macOS Keychain helper resolver returned a relative path",
      );
    }
    return keychainHelperExecutable;
  };
  const keychainCacheState = getKeychainCacheState(
    storageServiceName,
    username,
  );

  const readFromHelper = (): SecureStorageData | null => {
    let result: SecureStorageCommandResult;
    try {
      result = runCommand(
        getKeychainHelperExecutable(),
        ["read", storageServiceName, username],
        { stdio: ["ignore", "pipe", "pipe"], reject: false },
      );
    } catch (error) {
      throw new Error(
        `macOS Keychain lookup could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return decodeKeychainReadResult(result);
  };

  return {
    name: "keychain",
    read(): SecureStorageData | null {
      const cached = keychainCacheState.cache;
      if (
        !bypassReadCache &&
        Date.now() - cached.cachedAt < KEYCHAIN_CACHE_TTL_MS
      ) {
        return cached.data;
      }

      const data = readFromHelper();
      keychainCacheState.cache = { data, cachedAt: Date.now() };
      return data;
    },
    readFresh(): SecureStorageData | null {
      return createMacOsKeychainStorage(
        home,
        runCommand,
        storageServiceName,
        true,
        username,
        getKeychainHelperExecutable,
      ).read();
    },
    async readAsync(): Promise<SecureStorageData | null> {
      const prev = keychainCacheState.cache;
      if (
        !bypassReadCache &&
        Date.now() - prev.cachedAt < KEYCHAIN_CACHE_TTL_MS
      ) {
        return prev.data;
      }
      if (!bypassReadCache && keychainCacheState.readInFlight) {
        return keychainCacheState.readInFlight;
      }

      const gen = keychainCacheState.generation;
      const promise = (
        runCommand === runSecureStorageCommand
          ? doReadAsync(
              getKeychainHelperExecutable(),
              storageServiceName,
              username,
            )
          : Promise.resolve().then(readFromHelper)
      )
        .then((data) => {
          // If the cache was invalidated or updated while we were reading,
          // our subprocess result is stale — don't overwrite the newer entry.
          if (gen === keychainCacheState.generation) {
            keychainCacheState.cache = { data, cachedAt: Date.now() };
          }
          return data;
        })
        .finally(() => {
          if (keychainCacheState.readInFlight === promise) {
            keychainCacheState.readInFlight = null;
          }
        });
      keychainCacheState.readInFlight = promise;
      return promise;
    },
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      // Invalidate cache before update
      clearKeychainCacheState(keychainCacheState);

      try {
        const payload = jsonStringify(data);
        const payloadBytes = Buffer.byteLength(payload, "utf8");
        if (payloadBytes >= SECURE_STORAGE_HELPER_PAYLOAD_LIMIT_BYTES) {
          return {
            success: false,
            warning:
              `macOS Keychain credential payload is ${payloadBytes} bytes; ` +
              `records at or above ${SECURE_STORAGE_HELPER_PAYLOAD_LIMIT_BYTES} bytes are rejected`,
          };
        }
        const result = runCommand(
          getKeychainHelperExecutable(),
          ["write", storageServiceName, username],
          {
            input: payload,
            stdio: ["pipe", "pipe", "pipe"],
            reject: false,
          },
        );

        if (result.exitCode !== 0) {
          return {
            success: false,
            warning:
              result.stderr?.trim() ||
              `macOS Keychain write failed with exit code ${result.exitCode}`,
          };
        }

        // Update cache with new data on success
        keychainCacheState.cache = { data, cachedAt: Date.now() };
        return { success: true };
      } catch (error) {
        return {
          success: false,
          warning: `macOS Keychain write could not start: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    delete(): boolean {
      // Invalidate cache before delete
      clearKeychainCacheState(keychainCacheState);

      try {
        const result = runCommand(
          getKeychainHelperExecutable(),
          ["delete", storageServiceName, username],
          { stdio: ["ignore", "pipe", "pipe"], reject: false },
        );
        return result.exitCode === 0 || isKeychainItemNotFound(result);
      } catch (_e) {
        return false;
      }
    },
  };
}

async function doReadAsync(
  executable: string,
  storageServiceName: string,
  username: string,
): Promise<SecureStorageData | null> {
  let result;
  try {
    result = await execa(executable, ["read", storageServiceName, username], {
      reject: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      maxBuffer: SECURE_STORAGE_HELPER_PAYLOAD_LIMIT_BYTES,
    });
  } catch (error) {
    throw new Error(
      `macOS Keychain lookup could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isKeychainItemNotFound(result)) return null;
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        `macOS Keychain lookup failed with exit code ${result.exitCode}`,
    );
  }
  if (!result.stdout) {
    throw new Error("macOS Keychain returned an empty credential record");
  }
  return decodeSecureStorageData(result.stdout, "macOS Keychain");
}

let keychainLockedCache: boolean | undefined;

/**
 * Checks if the macOS keychain is locked.
 * Returns true if on macOS and keychain is locked (exit code 36 from security show-keychain-info).
 * This commonly happens in SSH sessions where the keychain isn't automatically unlocked.
 *
 * Cached for process lifetime — execaSync('security', ...) is a ~27ms sync
 * subprocess spawn, and this is called from render (AssistantTextMessage).
 * During virtual-scroll remounts on sessions with "Not logged in" messages,
 * each remount re-spawned security(1), adding 27ms/message to the commit.
 * Keychain lock state doesn't change during a CLI session.
 */
export function isMacOsKeychainLocked(): boolean {
  if (keychainLockedCache !== undefined) return keychainLockedCache;
  // Only check on macOS
  if (process.platform !== "darwin") {
    keychainLockedCache = false;
    return false;
  }

  try {
    const result = execaSync(MACOS_SECURITY_PATH, ["show-keychain-info"], {
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Exit code 36 indicates the keychain is locked
    keychainLockedCache = result.exitCode === 36;
  } catch {
    // If the command fails for any reason, assume keychain is not locked
    keychainLockedCache = false;
  }
  return keychainLockedCache;
}
