// Linux stand-in for the Windows handle-bound publication script.
// The production script is what runs on Windows. This models its confinement
// with a directory descriptor opened before the stage hooks, so a pathname
// swapped at a stage cannot redirect the create, write, rename, or delete.
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
    "DeleteWhenClosed",
    "SetFileInformationByHandle",
    "Invoke-PublishFault 'before-temp-create'",
    "Invoke-PublishFault 'before-temp-security'",
    "Invoke-PublishFault 'before-rename'",
    "Invoke-PublishFault 'before-published-check'",
    "target.Root = folder.DangerousGetHandle()",
    "0x200060",
    "0x100080",
  ];
  return required.every((needle) => script.includes(needle))
    && !script.includes("SetAccessControl")
    && !script.includes("Set-Acl");
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
      throw new Error(MOVED);
    }
    const destination = procPath(dirFd, input.name);
    let previous: Buffer | undefined;
    if (existsSync(destination)) {
      const current = lstatSync(destination, { bigint: true });
      if (current.isSymbolicLink() || !current.isFile()) throw new Error("publication target is a link or not a file");
      if (current.nlink === 1n) previous = readFileSync(destination);
    }
    renameSync(procPath(dirFd, input.temporary), destination);
    input.observe?.();
    input.onStage?.("before-published-check", info);
    input.observe?.();
    const published = lstatSync(destination, { bigint: true });
    if (!published.isFile() || published.nlink !== 1n || published.ino !== created.ino) {
      if (previous !== undefined) writeFileSync(destination, previous);
      throw new Error(REPLACED);
    }
    if (directoryMoved(input.directory, bound)) {
      if (previous !== undefined) writeFileSync(destination, previous);
      else unlinkSync(destination);
      throw new Error(MOVED);
    }
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (dirFd !== undefined) closeSync(dirFd);
  }
}
