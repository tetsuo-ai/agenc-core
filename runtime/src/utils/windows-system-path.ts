import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { win32 } from "node:path";

/** Kernel namespace path for the real Windows installation. */
export const WINDOWS_SYSTEM_ROOT_NAMESPACE = String.raw`\\?\GLOBALROOT\SystemRoot`;

export interface TrustedWindowsSystemPaths {
  /** Spawn-compatible DOS path derived from the kernel namespace. */
  readonly systemRoot: string;
  readonly system32: string;
  readonly powerShellRoot: string;
  /** GLOBALROOT aliases used to prove DOS executable identity. */
  readonly namespaceSystemRoot: string;
}

type CanonicalizePath = (path: string) => string;
export interface WindowsSystemExecutableIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}
export interface WindowsSystemExecutableFilesystem {
  lstat(path: string): WindowsSystemExecutableIdentity;
  open(path: string): number;
  fstat(descriptor: number): WindowsSystemExecutableIdentity;
  close(descriptor: number): void;
}

const WINDOWS_INVALID_FILE_ID = 0xffff_ffff_ffff_ffffn;
const WINDOWS_RESERVED_DEVICE_BASENAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const DEFAULT_EXECUTABLE_FILESYSTEM: WindowsSystemExecutableFilesystem = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  open: (path) =>
    openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    ),
  fstat: (descriptor) => fstatSync(descriptor, { bigint: true }),
  close: closeSync,
};

/**
 * Resolve process-environment and cwd paths from the true Windows namespace.
 *
 * CreateProcess requires drive-qualified DOS paths for both its executable and
 * current directory. `realpathSync.native` derives that spelling from
 * GLOBALROOT without consulting caller-controlled SystemRoot/WINDIR values.
 */
export function resolveTrustedWindowsSystemPaths(
  canonicalize: CanonicalizePath = realpathSync.native,
): TrustedWindowsSystemPaths {
  const systemRoot = canonicalize(WINDOWS_SYSTEM_ROOT_NAMESPACE);
  if (
    !/^[a-z]:\\/iu.test(systemRoot) ||
    win32.normalize(systemRoot) !== systemRoot
  ) {
    throw new Error(
      "trusted Windows SystemRoot did not resolve to a canonical local DOS path",
    );
  }

  const system32 = win32.join(systemRoot, "System32");
  const powerShellRoot = win32.join(system32, "WindowsPowerShell", "v1.0");
  return {
    systemRoot,
    system32,
    powerShellRoot,
    namespaceSystemRoot: WINDOWS_SYSTEM_ROOT_NAMESPACE,
  };
}

/** Resolve a DOS executable and prove it aliases the matching GLOBALROOT file. */
export function resolveTrustedWindowsSystemExecutable(
  paths: TrustedWindowsSystemPaths,
  relativeSegments: readonly string[],
  filesystem: WindowsSystemExecutableFilesystem =
    DEFAULT_EXECUTABLE_FILESYSTEM,
): string {
  if (
    relativeSegments.length === 0 ||
    relativeSegments.some((segment) => !isSafeWindowsExecutableSegment(segment))
  ) {
    throw new TypeError("trusted Windows executable segments are invalid");
  }

  const executable = win32.join(paths.systemRoot, ...relativeSegments);
  const namespaceExecutable = win32.join(
    paths.namespaceSystemRoot,
    ...relativeSegments,
  );
  verifyWindowsExecutableAliases(
    namespaceExecutable,
    executable,
    filesystem,
  );
  return executable;
}

function isSafeWindowsExecutableSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    win32.basename(segment) === segment &&
    !/[\u0000-\u001f<>:"/\\|?*]/u.test(segment) &&
    !/[ .]$/u.test(segment) &&
    !WINDOWS_RESERVED_DEVICE_BASENAME.test(segment)
  );
}

function verifyWindowsExecutableAliases(
  namespaceExecutable: string,
  executable: string,
  filesystem: WindowsSystemExecutableFilesystem,
): void {
  let namespaceDescriptor: number | undefined;
  let candidateDescriptor: number | undefined;
  let operationError: unknown;
  try {
    const namespaceBefore = filesystem.lstat(namespaceExecutable);
    const candidateBefore = filesystem.lstat(executable);
    assertRegularWindowsExecutable(namespaceBefore, "GLOBALROOT path");
    assertRegularWindowsExecutable(candidateBefore, "DOS path");

    namespaceDescriptor = filesystem.open(namespaceExecutable);
    candidateDescriptor = filesystem.open(executable);
    const namespaceOpened = filesystem.fstat(namespaceDescriptor);
    const candidateOpened = filesystem.fstat(candidateDescriptor);
    const namespaceAfter = filesystem.lstat(namespaceExecutable);
    const candidateAfter = filesystem.lstat(executable);

    assertRegularWindowsExecutable(namespaceOpened, "GLOBALROOT descriptor");
    assertRegularWindowsExecutable(candidateOpened, "DOS descriptor");
    assertRegularWindowsExecutable(namespaceAfter, "GLOBALROOT path");
    assertRegularWindowsExecutable(candidateAfter, "DOS path");
    for (const identity of [
      namespaceBefore,
      candidateBefore,
      namespaceOpened,
      candidateOpened,
      namespaceAfter,
      candidateAfter,
    ]) {
      assertSupportedWindowsExecutableIdentity(identity);
    }
    if (
      !sameWindowsExecutableIdentity(namespaceBefore, namespaceOpened) ||
      !sameWindowsExecutableIdentity(namespaceOpened, namespaceAfter) ||
      !sameWindowsExecutableIdentity(candidateBefore, candidateOpened) ||
      !sameWindowsExecutableIdentity(candidateOpened, candidateAfter) ||
      !sameWindowsExecutableIdentity(namespaceOpened, candidateOpened)
    ) {
      throw new Error("trusted Windows system executable identity mismatch");
    }
  } catch (error) {
    operationError = error;
  }

  const closeErrors: unknown[] = [];
  for (const descriptor of [candidateDescriptor, namespaceDescriptor]) {
    if (descriptor === undefined) continue;
    try {
      filesystem.close(descriptor);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (operationError !== undefined) {
    if (closeErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...closeErrors],
        "trusted Windows executable validation and cleanup both failed",
      );
    }
    throw operationError;
  }
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) {
    throw new AggregateError(
      closeErrors,
      "trusted Windows executable descriptor cleanup failed",
    );
  }
}

function assertRegularWindowsExecutable(
  identity: WindowsSystemExecutableIdentity,
  spelling: string,
): void {
  if (!identity.isFile() || identity.isSymbolicLink()) {
    throw new Error(
      `trusted Windows ${spelling} executable is not a regular non-link file`,
    );
  }
}

function assertSupportedWindowsExecutableIdentity(
  identity: WindowsSystemExecutableIdentity,
): void {
  if (
    identity.dev <= 0n ||
    identity.ino <= 0n ||
    identity.dev === WINDOWS_INVALID_FILE_ID ||
    identity.ino === WINDOWS_INVALID_FILE_ID
  ) {
    throw new Error("trusted Windows system executable identity is unavailable");
  }
}

function sameWindowsExecutableIdentity(
  left: WindowsSystemExecutableIdentity,
  right: WindowsSystemExecutableIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
