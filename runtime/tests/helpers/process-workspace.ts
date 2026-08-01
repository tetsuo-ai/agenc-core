import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { readBoundedRegularFile } from "./bounded-file-io.js";
import {
  isWellFormedUnicode,
  portablePathIdentity,
} from "./portable-repository-path.js";

const CONTROL_CHARACTER_PATTERN = /\u0000/u;
const MAX_PATH_BYTES = 16_384;

export interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly links: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
}

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
}

export interface ValidatedProcessLocation {
  readonly program: string;
  readonly programIdentity: FileIdentity;
  readonly cwd: string;
  readonly cwdIdentity: FileIdentity;
}

export interface BoundedFileSnapshot {
  readonly bytes: Buffer;
}

export interface PinnedProcessWorkspace {
  readonly root: string;
  validateProcessLocation(
    program: string,
    cwd: string,
  ): Promise<ValidatedProcessLocation>;
  revalidateProcessLocation(location: ValidatedProcessLocation): Promise<void>;
  resolveOwnedFile(path: string, label: string): Promise<string>;
  portableIdentityOfOwnedFile(absolutePath: string, label: string): string;
  assertOwnedFileAbsent(absolutePath: string, label: string): Promise<void>;
  readBoundedFileIfPresent(
    absolutePath: string,
    maximumBytes: number,
  ): Promise<BoundedFileSnapshot | null>;
}

export async function pinProcessWorkspace(
  root: string,
): Promise<PinnedProcessWorkspace> {
  assertSafePath(root, "child-process workspace root");
  if (!isAbsolute(root)) {
    throw new Error("child-process workspace root must be absolute");
  }
  const canonicalRoot = await realpath(root);
  const status = await lstat(canonicalRoot, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("child-process workspace root must be a directory");
  }
  return new PinnedProcessWorkspaceImplementation(
    canonicalRoot,
    directoryIdentityOf(status),
  );
}

class PinnedProcessWorkspaceImplementation implements PinnedProcessWorkspace {
  readonly root: string;
  readonly #rootIdentity: DirectoryIdentity;

  constructor(root: string, rootIdentity: DirectoryIdentity) {
    this.root = root;
    this.#rootIdentity = rootIdentity;
  }

  async validateProcessLocation(
    program: string,
    cwd: string,
  ): Promise<ValidatedProcessLocation> {
    await this.#assertRootIdentity();
    if (!isAbsolute(program)) {
      throw new Error("child program must be an absolute path");
    }
    if (!isAbsolute(cwd)) {
      throw new Error("child working directory must be absolute");
    }

    const programStatus = await lstat(program, { bigint: true });
    const programIdentity = executableIdentityOf(programStatus);

    const canonicalCwd = await realpath(cwd);
    assertInsideOrEqual(this.root, canonicalCwd, "child working directory");
    const cwdStatus = await lstat(canonicalCwd, { bigint: true });
    if (cwdStatus.isSymbolicLink() || !cwdStatus.isDirectory()) {
      throw new Error(
        "child working directory must be a non-symlink directory",
      );
    }

    return Object.freeze({
      program,
      programIdentity,
      cwd: canonicalCwd,
      cwdIdentity: fileIdentityOf(cwdStatus),
    });
  }

  async revalidateProcessLocation(
    location: ValidatedProcessLocation,
  ): Promise<void> {
    await this.#assertRootIdentity();
    const [programStatus, cwdStatus] = await Promise.all([
      lstat(location.program, { bigint: true }),
      lstat(location.cwd, { bigint: true }),
    ]);
    if (
      !sameFileIdentity(
        location.programIdentity,
        executableIdentityOf(programStatus),
      )
    ) {
      throw new Error("child program identity changed before spawn");
    }
    if (
      !cwdStatus.isDirectory() ||
      !sameFileIdentity(location.cwdIdentity, fileIdentityOf(cwdStatus))
    ) {
      throw new Error("child working-directory identity changed before spawn");
    }
    if ((await realpath(location.cwd)) !== location.cwd) {
      throw new Error("child working-directory pathname changed before spawn");
    }
  }

  async resolveOwnedFile(path: string, label: string): Promise<string> {
    await this.#assertRootIdentity();
    assertSafePath(path, label);
    const candidate = isAbsolute(path)
      ? resolve(path)
      : resolve(this.root, path);
    if (candidate === this.root) {
      throw new Error(`${label} cannot be the workspace root`);
    }
    const canonicalParent = await realpath(dirname(candidate));
    assertInsideOrEqual(this.root, canonicalParent, label);
    const ownedPath = join(canonicalParent, basename(candidate));
    assertInsideOrEqual(this.root, ownedPath, label);
    this.portableIdentityOfOwnedFile(ownedPath, label);
    return ownedPath;
  }

  portableIdentityOfOwnedFile(absolutePath: string, label: string): string {
    assertInsideOrEqual(this.root, absolutePath, label);
    const relativePath = relative(this.root, absolutePath).split(sep).join("/");
    return portablePathIdentity(relativePath);
  }

  async assertOwnedFileAbsent(
    absolutePath: string,
    label: string,
  ): Promise<void> {
    await this.#assertRootIdentity();
    assertInsideOrEqual(this.root, absolutePath, label);
    const parent = dirname(absolutePath);
    const canonicalParent = await realpath(parent);
    if (canonicalParent !== parent) {
      throw new Error(`${label} parent identity changed before spawn`);
    }
    const parentIdentity = directoryIdentityOf(
      await lstat(parent, { bigint: true }),
    );
    try {
      await lstat(absolutePath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#assertRootIdentity();
      const parentAfter = directoryIdentityOf(
        await lstat(parent, { bigint: true }),
      );
      if (!sameDirectoryIdentity(parentIdentity, parentAfter)) {
        throw new Error(`${label} parent identity changed before spawn`);
      }
      return;
    }
    throw new Error(`${label} must be absent before spawn`);
  }

  async readBoundedFileIfPresent(
    absolutePath: string,
    maximumBytes: number,
  ): Promise<BoundedFileSnapshot | null> {
    await this.#assertRootIdentity();
    assertInsideOrEqual(this.root, absolutePath, "child-owned file");
    const parent = dirname(absolutePath);
    const canonicalParent = await realpath(parent);
    if (canonicalParent !== parent) {
      throw new Error("child-owned file parent identity changed");
    }
    assertInsideOrEqual(this.root, canonicalParent, "child-owned file");
    const parentIdentity = directoryIdentityOf(
      await lstat(parent, { bigint: true }),
    );

    try {
      await lstat(absolutePath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.#assertParentIdentity(
          parent,
          parentIdentity,
          "after absence",
        );
        return null;
      }
      throw error;
    }

    let bytes: Buffer;
    try {
      bytes = await readBoundedRegularFile(absolutePath, {
        byteLimit: maximumBytes,
        label: "child-owned file",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("child-owned file changed before descriptor open", {
          cause: error,
        });
      }
      throw error;
    }
    await this.#assertParentIdentity(parent, parentIdentity, "after read");
    return Object.freeze({ bytes });
  }

  async #assertRootIdentity(): Promise<void> {
    const actual = directoryIdentityOf(
      await lstat(this.root, { bigint: true }),
    );
    if (!sameDirectoryIdentity(this.#rootIdentity, actual)) {
      throw new Error("child-process workspace identity changed");
    }
  }

  async #assertParentIdentity(
    parent: string,
    expected: DirectoryIdentity,
    phase: string,
  ): Promise<void> {
    await this.#assertRootIdentity();
    if ((await realpath(parent)) !== parent) {
      throw new Error(`child-owned file parent identity changed ${phase}`);
    }
    const actual = directoryIdentityOf(await lstat(parent, { bigint: true }));
    if (!sameDirectoryIdentity(expected, actual)) {
      throw new Error(`child-owned file parent identity changed ${phase}`);
    }
  }
}

function executableIdentityOf(status: BigIntStats): FileIdentity {
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1n) {
    throw new Error("child program must be a singly-linked regular file");
  }
  return fileIdentityOf(status);
}

function fileIdentityOf(status: BigIntStats): FileIdentity {
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    links: status.nlink,
    mode: status.mode,
    size: status.size,
    modifiedNs: status.mtimeNs,
    changedNs: status.ctimeNs,
  });
}

function directoryIdentityOf(status: BigIntStats): DirectoryIdentity {
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("child-process workspace path is not a directory");
  }
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    mode: status.mode,
  });
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.links === right.links &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode
  );
}

function assertInsideOrEqual(root: string, path: string, label: string): void {
  const displacement = relative(root, path);
  if (
    displacement === ".." ||
    displacement.startsWith(`..${sep}`) ||
    isAbsolute(displacement)
  ) {
    throw new Error(`${label} escapes the child-process workspace`);
  }
}

function assertSafePath(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !isWellFormedUnicode(value) ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
  ) {
    throw new Error(`${label} contains an unsafe path`);
  }
}
