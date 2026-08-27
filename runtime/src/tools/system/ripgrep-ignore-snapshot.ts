import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveSessionTempRoot } from "../../session/runtime-options.js";
import { safePath } from "./filesystem.js";

export interface RipgrepIgnoreFileSnapshot {
  readonly sourceName: string;
  readonly content: Buffer;
}

export interface MaterializedRipgrepIgnoreFiles {
  readonly paths: readonly string[];
  readonly dispose: () => Promise<void>;
}

interface StableFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function stableFileIdentity(stats: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): StableFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameStableFileIdentity(
  left: StableFileIdentity,
  right: StableFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Snapshot an unprotected ignore file while proving that the opened descriptor
 * is the same regular file admitted before and still named after the read.
 */
export async function readVerifiedRipgrepIgnoreFile(params: {
  readonly path: string;
  readonly allowedRoot: string;
  readonly maximumBytes: number;
}): Promise<Buffer | undefined> {
  const checked = await safePath(params.path, [params.allowedRoot]);
  if (!checked.safe) return undefined;
  const before = await lstat(checked.resolved, { bigint: true }).catch(
    (error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    },
  );
  if (before === undefined || before.isSymbolicLink() || !before.isFile()) {
    return undefined;
  }
  const beforeIdentity = stableFileIdentity(before);
  const noFollow =
    process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0;
  const handle = await open(
    checked.resolved,
    constants.O_RDONLY | noFollow,
  ).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (handle === undefined) return undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      !sameStableFileIdentity(beforeIdentity, stableFileIdentity(opened))
    ) {
      throw new Error("ripgrep ignore file identity changed before read");
    }
    const buffer = Buffer.alloc(params.maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > params.maximumBytes) {
      throw new Error(
        `ripgrep ignore file exceeds ${params.maximumBytes} bytes`,
      );
    }
    const afterOpened = await handle.stat({ bigint: true });
    const afterNamed = await lstat(checked.resolved, { bigint: true });
    if (
      afterNamed.isSymbolicLink() ||
      !afterNamed.isFile() ||
      !sameStableFileIdentity(
        beforeIdentity,
        stableFileIdentity(afterOpened),
      ) ||
      !sameStableFileIdentity(beforeIdentity, stableFileIdentity(afterNamed))
    ) {
      throw new Error("ripgrep ignore file identity changed during read");
    }
    return Buffer.from(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * Materialize verified bytes beneath a private temporary directory. Ripgrep's
 * --ignore-file rules are relative to cwd, not the rules file location, so an
 * absolute private snapshot preserves semantics without reopening workspace
 * pathnames after descriptor verification.
 */
export async function materializeRipgrepIgnoreFiles(
  snapshots: readonly RipgrepIgnoreFileSnapshot[],
): Promise<MaterializedRipgrepIgnoreFiles> {
  if (snapshots.length === 0) {
    return { paths: [], dispose: async () => {} };
  }
  const directory = await mkdtemp(
    join(resolveSessionTempRoot(), "agenc-rg-ignore-"),
  );
  try {
    const paths: string[] = [];
    for (const [index, snapshot] of snapshots.entries()) {
      const path = join(directory, `ignore-${index}`);
      await writeFile(path, snapshot.content, {
        flag: "wx",
        mode: 0o600,
      });
      paths.push(path);
    }
    let disposed = false;
    return {
      paths,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
