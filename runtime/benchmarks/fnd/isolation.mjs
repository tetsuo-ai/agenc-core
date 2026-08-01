import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export const OWNED_TEMPORARY_ROOT_PREFIX = "agenc-fnd-bench-";

const HOST_CONTROL_ENTRY_NAMES = Object.freeze([".git", ".ignore"]);
const OWNED_TEMPORARY_ROOT_CLEANUP_MAX_RETRIES = 12;
const OWNED_TEMPORARY_ROOT_CLEANUP_RETRY_DELAY_MS = 50;
const OWNED_TEMPORARY_ROOT_CLEANUP_RETRY_ERROR_CODES = Object.freeze([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
]);
const OWNED_TEMPORARY_ROOT_CLEANUP_WAIT_INDEX = 0;
const OWNED_TEMPORARY_ROOT_CLEANUP_WAIT_VALUE = 0;
const ownedTemporaryRootCleanupWait = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
const RETAIN_OWNED_TEMPORARY_ROOT = Symbol("retainOwnedTemporaryRoot");
const RETAINED_OWNED_TEMPORARY_ROOT_PATH = Symbol(
  "retainedOwnedTemporaryRootPath",
);

/**
 * @template Result
 * @param {(temporaryRoot: string) => Result | Promise<Result>} callback
 * @returns {Promise<Result>}
 */
export async function withOwnedTemporaryRoot(callback) {
  if (typeof callback !== "function") {
    throw new Error("owned temporary root callback must be a function");
  }
  const temporaryRoot = createOwnedTemporaryRoot();
  const temporaryRootIdentity =
    captureOwnedTemporaryRootIdentity(temporaryRoot);
  let callbackFailure;
  try {
    return await callback(temporaryRoot);
  } catch (error) {
    callbackFailure = error;
    throw error;
  } finally {
    if (requiresOwnedTemporaryRootRetention(callbackFailure)) {
      Object.defineProperty(
        callbackFailure,
        RETAINED_OWNED_TEMPORARY_ROOT_PATH,
        { value: temporaryRoot },
      );
      if (callbackFailure instanceof Error) {
        callbackFailure.message += `; owned temporary root retained at ${temporaryRoot}`;
      }
    } else {
      cleanupOwnedTemporaryRoot(temporaryRoot, temporaryRootIdentity);
    }
  }
}

export function markOwnedTemporaryRootForRetention(error) {
  const retainedError =
    error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(retainedError, RETAIN_OWNED_TEMPORARY_ROOT, {
    value: true,
  });
  return retainedError;
}

export function retainedOwnedTemporaryRootPath(error) {
  if (error === null || typeof error !== "object") return undefined;
  return error[RETAINED_OWNED_TEMPORARY_ROOT_PATH];
}

export function createOwnedTemporaryRoot() {
  const temporaryRoot = mkdtempSync(
    join(resolve(tmpdir()), OWNED_TEMPORARY_ROOT_PREFIX),
  );
  assertOwnedTemporaryRoot(temporaryRoot, { requireEmpty: true });
  return temporaryRoot;
}

export function assertOwnedTemporaryRoot(
  temporaryRoot,
  { requireEmpty = false, temporaryDirectory = tmpdir() } = {},
) {
  const resolvedRoot = validateOwnedTemporaryRootPath(
    temporaryRoot,
    temporaryDirectory,
  );
  const metadata = lstatSync(resolvedRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("benchmark temporary root must be a non-symlink directory");
  }
  if (requireEmpty && readdirSync(resolvedRoot).length !== 0) {
    throw new Error("benchmark temporary root must start empty");
  }
  return resolvedRoot;
}

export function cleanupOwnedTemporaryRoot(
  temporaryRoot,
  expectedIdentity = undefined,
) {
  const resolvedRoot = validateOwnedTemporaryRootPath(temporaryRoot);
  let cleanupIdentity = expectedIdentity;
  for (
    let retryIndex = 0;
    retryIndex <= OWNED_TEMPORARY_ROOT_CLEANUP_MAX_RETRIES;
    retryIndex += 1
  ) {
    let metadata;
    try {
      metadata = lstatSync(resolvedRoot, { bigint: true });
    } catch (error) {
      if (isMissingPathError(error) && cleanupIdentity === undefined) return;
      if (!isMissingPathError(error)) throw error;
      throw new Error(
        `owned temporary root disappeared before identity-checked cleanup: ${resolvedRoot}`,
        { cause: error },
      );
    }
    cleanupIdentity ??= ownedTemporaryRootIdentity(metadata);
    if (!ownedTemporaryRootIdentityMatches(metadata, cleanupIdentity)) {
      throw new Error(
        `owned temporary root identity changed; refusing recursive cleanup: ${resolvedRoot}`,
      );
    }
    try {
      rmSync(resolvedRoot, {
        force: true,
        recursive: metadata.isDirectory() && !metadata.isSymbolicLink(),
      });
      return;
    } catch (error) {
      if (
        retryIndex >= OWNED_TEMPORARY_ROOT_CLEANUP_MAX_RETRIES ||
        !isRetryableCleanupError(error)
      ) {
        throw error;
      }
      waitForOwnedTemporaryRootCleanupRetry(retryIndex);
    }
  }
}

export function assertNoAncestorBenchmarkControls(
  temporaryRoot,
  temporaryDirectory = tmpdir(),
) {
  assertNoBenchmarkControlsAtOrAbove(
    assertOwnedTemporaryRoot(temporaryRoot, { temporaryDirectory }),
  );
}

export function assertNoBenchmarkControlsAtOrAbove(startingDirectory) {
  let current = resolve(startingDirectory);
  while (true) {
    for (const entryName of HOST_CONTROL_ENTRY_NAMES) {
      try {
        lstatSync(join(current, entryName));
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }
      throw new Error(
        `benchmark temporary root inherits host ${entryName} control state`,
      );
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function validateOwnedTemporaryRootPath(
  temporaryRoot,
  temporaryDirectory = tmpdir(),
) {
  if (typeof temporaryRoot !== "string" || temporaryRoot.length === 0) {
    throw new Error("benchmark temporary root path must be non-empty");
  }
  const resolvedTemporaryDirectory = resolve(temporaryDirectory);
  const resolvedRoot = resolve(temporaryRoot);
  if (
    resolvedRoot === resolvedTemporaryDirectory ||
    dirname(resolvedRoot) !== resolvedTemporaryDirectory ||
    !basename(resolvedRoot).startsWith(OWNED_TEMPORARY_ROOT_PREFIX)
  ) {
    throw new Error("benchmark temporary root is outside the owned namespace");
  }
  return resolvedRoot;
}

function captureOwnedTemporaryRootIdentity(temporaryRoot) {
  const metadata = lstatSync(temporaryRoot, { bigint: true });
  return ownedTemporaryRootIdentity(metadata);
}

function ownedTemporaryRootIdentity(metadata) {
  return Object.freeze({ device: metadata.dev, inode: metadata.ino });
}

function ownedTemporaryRootIdentityMatches(metadata, expectedIdentity) {
  return (
    metadata.dev === expectedIdentity.device &&
    metadata.ino === expectedIdentity.inode
  );
}

function requiresOwnedTemporaryRootRetention(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    error[RETAIN_OWNED_TEMPORARY_ROOT] === true
  );
}

function isMissingPathError(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isRetryableCleanupError(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    OWNED_TEMPORARY_ROOT_CLEANUP_RETRY_ERROR_CODES.includes(error.code)
  );
}

function waitForOwnedTemporaryRootCleanupRetry(retryIndex) {
  const delayMs =
    OWNED_TEMPORARY_ROOT_CLEANUP_RETRY_DELAY_MS * (retryIndex + 1);
  Atomics.wait(
    ownedTemporaryRootCleanupWait,
    OWNED_TEMPORARY_ROOT_CLEANUP_WAIT_INDEX,
    OWNED_TEMPORARY_ROOT_CLEANUP_WAIT_VALUE,
    delayMs,
  );
}
