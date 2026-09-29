import { runtimeSpan } from "../diagnostics/runtime-timing.js";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface DurableAtomicSyncOperations {
  mkdir(path: string): void;
  openTemporary(path: string, mode: number): unknown;
  write(handle: unknown, data: string): void;
  sync(handle: unknown): void;
  close(handle: unknown): void;
  rename(from: string, to: string): void;
  syncDirectory(path: string): void;
  remove(path: string): void;
}

export interface DurableAtomicAsyncOperations {
  mkdir(path: string): Promise<void>;
  openTemporary(path: string, mode: number): Promise<unknown>;
  write(handle: unknown, data: string): Promise<void>;
  sync(handle: unknown): Promise<void>;
  close(handle: unknown): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const DEFAULT_SYNC_OPERATIONS: DurableAtomicSyncOperations = {
  mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
  openTemporary: (path, mode) => openSync(path, "wx", mode),
  write: (handle, data) => writeFileSync(handle as number, data),
  sync: (handle) => fsyncSync(handle as number),
  close: (handle) => closeSync(handle as number),
  rename: renameSync,
  syncDirectory: syncDirectorySync,
  remove: (path) => rmSync(path, { force: true }),
};

const DEFAULT_ASYNC_OPERATIONS: DurableAtomicAsyncOperations = {
  mkdir: async (path) =>
    mkdir(path, { recursive: true, mode: 0o700 }).then(() => {}),
  openTemporary: (path, mode) => open(path, "wx", mode),
  write: async (handle, data) =>
    (handle as Awaited<ReturnType<typeof open>>).writeFile(data).then(() => {}),
  sync: (handle) => (handle as Awaited<ReturnType<typeof open>>).sync(),
  close: (handle) => (handle as Awaited<ReturnType<typeof open>>).close(),
  rename,
  syncDirectory: syncDirectory,
  remove: async (path) => rm(path, { force: true }),
};

export function writeDurableAtomicFileSync(
  path: string,
  temporaryPath: string,
  data: string,
  mode = 0o600,
  operations: DurableAtomicSyncOperations = DEFAULT_SYNC_OPERATIONS,
): void {
  const finishRuntimeSpan = runtimeSpan("persistence.atomic_sync");
  try {
  operations.mkdir(dirname(path));
  let handle: unknown;
  let openHandle = false;
  let temporaryCreated = false;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    handle = operations.openTemporary(temporaryPath, mode);
    openHandle = true;
    temporaryCreated = true;
    operations.write(handle, data);
    operations.sync(handle);
    // A close attempt may have closed the descriptor even when it reports an
    // error. Mark it consumed first so cleanup never double-closes it.
    openHandle = false;
    operations.close(handle);
    operations.rename(temporaryPath, path);
    operations.syncDirectory(dirname(path));
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupErrors: unknown[] = [];
  if (openHandle) {
    openHandle = false;
    try {
      operations.close(handle);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (temporaryCreated) {
    try {
      operations.remove(temporaryPath);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwDurableAtomicFileErrors(hasPrimaryError, primaryError, cleanupErrors);

  } finally { finishRuntimeSpan(); }
}

export async function writeDurableAtomicFile(
  path: string,
  temporaryPath: string,
  data: string,
  mode = 0o600,
  operations: DurableAtomicAsyncOperations = DEFAULT_ASYNC_OPERATIONS,
): Promise<void> {
  const finishRuntimeSpan = runtimeSpan("persistence.atomic_async");
  try {
  await operations.mkdir(dirname(path));
  let handle: unknown;
  let openHandle = false;
  let temporaryCreated = false;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    handle = await operations.openTemporary(temporaryPath, mode);
    openHandle = true;
    temporaryCreated = true;
    await operations.write(handle, data);
    await operations.sync(handle);
    openHandle = false;
    await operations.close(handle);
    await operations.rename(temporaryPath, path);
    await operations.syncDirectory(dirname(path));
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupErrors: unknown[] = [];
  if (openHandle) {
    openHandle = false;
    try {
      await operations.close(handle);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (temporaryCreated) {
    try {
      await operations.remove(temporaryPath);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwDurableAtomicFileErrors(hasPrimaryError, primaryError, cleanupErrors);

  } finally { finishRuntimeSpan(); }
}

function throwDurableAtomicFileErrors(
  hasPrimaryError: boolean,
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
): void {
  if (hasPrimaryError) {
    if (cleanupErrors.length === 0) throw primaryError;
    const message =
      primaryError instanceof Error
        ? primaryError.message
        : String(primaryError);
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `Durable atomic file publication failed: ${message}`,
      { cause: primaryError },
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      "Durable atomic file cleanup failed",
    );
  }
}

function syncDirectorySync(path: string): void {
  let descriptor: number | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) {
      primaryError = error;
      hasPrimaryError = true;
    }
  }
  const cleanupErrors: unknown[] = [];
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwDurableAtomicFileErrors(hasPrimaryError, primaryError, cleanupErrors);
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) {
      primaryError = error;
      hasPrimaryError = true;
    }
  }
  const cleanupErrors: unknown[] = [];
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwDurableAtomicFileErrors(hasPrimaryError, primaryError, cleanupErrors);
}

/** @internal Exported for the cross-platform durability contract test. */
export function isUnsupportedDirectorySync(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EINVAL" || code === "ENOTSUP") return true;
  return (
    platform === "win32" &&
    (code === "EACCES" ||
      code === "EBADF" ||
      code === "EISDIR" ||
      code === "EPERM")
  );
}
