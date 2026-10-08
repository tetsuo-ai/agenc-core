// Linux stand-in for the Windows handle-bound publication script.
// The production script is what runs on Windows. This models its confinement
// AND its #2976 r9 replacement/recovery transaction with a directory descriptor
// opened before the stage hooks, so a pathname swapped at a stage cannot
// redirect the create, write, rename, or restore, and a failure after the
// atomic replace restores the previous record instead of leaving the canonical
// name missing. Scope: this models the transaction ordering and recovery on
// Linux files; it does not exercise the native NtSetInformationFile class 65
// rename, which the #2976 r9 native tests prove on Windows.
// A script that is not handle-bound is published by pathname instead, which
// the F1 probes reject.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type WindowsPublicationStageName =
  | "before-temp-create"
  | "before-temp-security"
  | "before-rename"
  | "after-rename"
  | "before-published-check";

export interface WindowsPublicationStageInfo {
  readonly temporaryPath: string;
  readonly destinationPath: string;
}

const REPLACED = "Cron temporary publication file was replaced or linked";
const MOVED = "publication directory changed before acknowledgement";

export function publicationScriptIsHandleBound(script: string): boolean {
  const required = [
    "OpenPublishFolder",
    "CreateNewChild",
    "RenameWithin",
    "ReadRecord",
    "DeleteWhenClosed",
    "Invoke-PublishFault 'before-temp-create'",
    "Invoke-PublishFault 'before-temp-security'",
    "Invoke-PublishFault 'before-rename'",
    "Invoke-PublishFault 'after-rename'",
    "Invoke-PublishFault 'before-published-check'",
    "target.Root = folder.DangerousGetHandle()",
    "0x200060",
    "0x100080",
  ];
  return required.every((needle) => script.includes(needle))
    && !script.includes("SetAccessControl")
    && !script.includes("Set-Acl");
}

/**
 * Measured on Windows build 26200 (ARM64, PowerShell 5.1 and 7; #2976 r8
 * reproducer): kernel32 SetFileInformationByHandle fails a rename whose
 * RootDirectory is set with ERROR_INVALID_PARAMETER (87), whatever the buffer
 * size. The #2976 r9 reproducer then showed NtSetInformationFile class 65
 * (FileRenameInformationEx) with FILE_RENAME_REPLACE_IF_EXISTS |
 * FILE_RENAME_POSIX_SEMANTICS replaces the target atomically. The stand-in
 * requires the shipped RenameWithin to use that class-65 call.
 */
function renameFailure(script: string): string | undefined {
  const start = script.indexOf("public static void RenameWithin(");
  if (start < 0) return "publication rename failed (RenameWithin is missing)";
  const body = script.slice(start, script.indexOf("public static", start + 1));
  if (body.includes("SetFileInformationByHandle(")) return "publication rename failed (Win32 error 87)";
  if (!/NtSetInformationFile\(file, out result, buffer, size, 65\)/u.test(body)) {
    return "publication rename failed (no directory-relative class-65 rename)";
  }
  return undefined;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
    if (wrote <= 0) throw new Error("publication write did not match the task bytes");
    offset += wrote;
  }
  fsyncSync(fd);
}

function directoryMoved(directory: string, bound: { dev: bigint; ino: bigint }): boolean {
  try {
    const current = lstatSync(directory, { bigint: true });
    return current.isSymbolicLink() || !current.isDirectory()
      || current.dev !== bound.dev || current.ino !== bound.ino;
  } catch {
    return true;
  }
}

function procPath(dirFd: number, name: string): string {
  return `/proc/self/fd/${dirFd}/${name}`;
}

export function simulateWindowsPublication(input: {
  readonly directory: string;
  readonly volume: string;
  readonly fileId: string;
  readonly name: string;
  readonly temporary: string;
  readonly bytes: Buffer;
  readonly script: string;
  readonly observe?: () => void;
  readonly onStage?: (stage: WindowsPublicationStageName, info: WindowsPublicationStageInfo) => void;
  readonly onPathMutation?: (path: string) => void;
  // Test seam: force a failure after the atomic replace (models a flush /
  // published-check failure) so the recovery path can be exercised on Linux.
  readonly failAfterReplace?: "published-check" | "directory-moved";
}): void {
  const temporaryPath = join(input.directory, input.temporary);
  const destinationPath = join(input.directory, input.name);
  const info = { temporaryPath, destinationPath };
  if (!publicationScriptIsHandleBound(input.script)) {
    input.onStage?.("before-temp-create", info);
    writeFileSync(temporaryPath, input.bytes);
    input.observe?.();
    input.onStage?.("before-temp-security", info);
    input.onPathMutation?.(temporaryPath);
    renameSync(temporaryPath, destinationPath);
    input.onStage?.("before-published-check", info);
    input.onPathMutation?.(destinationPath);
    input.observe?.();
    return;
  }
  let dirFd: number | undefined;
  let fileFd: number | undefined;
  try {
    try {
      dirFd = openSync(input.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENOTDIR") throw new Error("reparse points are unsupported");
      throw error;
    }
    const dirFdLocal = dirFd;
    const bound = fstatSync(dirFd, { bigint: true });
    if (!bound.isDirectory() || bound.dev.toString() !== input.volume || bound.ino.toString() !== input.fileId) {
      throw new Error("directory identity changed before its ACL was set");
    }
    input.onStage?.("before-temp-create", info);
    fileFd = openSync(procPath(dirFd, input.temporary), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeAll(fileFd, input.bytes);
    input.observe?.();
    const created = fstatSync(fileFd, { bigint: true });
    if (!created.isFile() || created.nlink !== 1n) throw new Error(REPLACED);
    input.onStage?.("before-temp-security", info);
    const secured = fstatSync(fileFd, { bigint: true });
    if (!secured.isFile() || secured.nlink !== 1n || secured.ino !== created.ino) throw new Error(REPLACED);
    input.onStage?.("before-rename", info);
    const beforeRename = fstatSync(fileFd, { bigint: true });
    if (!beforeRename.isFile() || beforeRename.nlink !== 1n || beforeRename.ino !== created.ino) throw new Error(REPLACED);
    if (directoryMoved(input.directory, bound)) {
      unlinkSync(procPath(dirFd, input.temporary));
      throw new Error(`${MOVED} [previous-record-untouched]`);
    }
    const destination = procPath(dirFd, input.name);
    // Capture the previous record before the replace, so a post-replace failure
    // restores it. The canonical name is never vacated first.
    let previous: Buffer | undefined;
    let existed = false;
    if (existsSync(destination)) {
      const current = lstatSync(destination, { bigint: true });
      if (current.isSymbolicLink() || !current.isFile()) throw new Error("publication target is a link or not a file");
      existed = true;
      previous = readFileSync(destination);
    }
    const refused = renameFailure(input.script);
    if (refused !== undefined) {
      unlinkSync(procPath(dirFd, input.temporary));
      throw new Error(`${refused} [previous-record-untouched]`);
    }
    // One atomic replacement: the name points to the complete old or new file
    // at every instant (models NtSetInformationFile class 65 POSIX replace).
    const restore = (failure: string): never => {
      if (existed && previous !== undefined) {
        const restoreTemp = procPath(dirFdLocal, `${input.temporary}.bak`);
        writeFileSync(restoreTemp, previous);
        renameSync(restoreTemp, destination);
        throw new Error(`${failure} [previous-record-restored]`);
      }
      throw new Error(`${failure} [new-record-in-place]`);
    };
    renameSync(procPath(dirFd, input.temporary), destination);
    input.observe?.();
    input.onStage?.("after-rename", info);
    if (input.failAfterReplace === "published-check") restore(REPLACED);
    if (input.failAfterReplace === "directory-moved") restore(MOVED);
    try {
      fsyncSync(dirFd);
    } catch {
      restore(MOVED);
    }
    input.onStage?.("before-published-check", info);
    input.observe?.();
    const published = lstatSync(destination, { bigint: true });
    if (!published.isFile() || published.nlink !== 1n || published.ino !== created.ino) restore(REPLACED);
    if (directoryMoved(input.directory, bound)) restore(MOVED);
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (dirFd !== undefined) closeSync(dirFd);
  }
}
