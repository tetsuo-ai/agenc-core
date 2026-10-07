import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertWindowsPrivatePathSecurity } from "../agents/workflow-private-path.js";
import {
  noFollowFlag,
  readConfinedFile,
  sameIdentity,
  withRegularChild,
  type ConfinedDirectory,
} from "../fs/descriptor-confined-io.js";
import { MAX_CRON_FILE_BYTES } from "./cron-delivery-state.js";
import { isUnsupportedDirectorySync, writeDurableAtomicFile } from "./durable-atomic-file.js";
import { acquireLocalSqliteLock, assertLocalPrivateDirectory, type LocalSqliteLockOptions } from "./sqlite-lock.js";

import { assertOwned, CRON_STORAGE_NAME, withCronStorageDirectory } from "./cron-storage-directory.js";
export { CRON_STORAGE_NAME } from "./cron-storage-directory.js";

export interface CronStorage {
  readonly directory: ConfinedDirectory;
  readonly workspaceIdentity: string;
  readonly lockDirectory: string;
  read(): Promise<string | undefined>;
  write(data: string): Promise<void>;
}

/** All JSON I/O, including temporary publication and cleanup, retains both roots. */
export async function withCronStorage<Result>(
  workspacePath: string,
  create: boolean,
  operation: (storage: CronStorage) => Promise<Result>,
  expectedWorkspaceIdentity?: string,
): Promise<Result | undefined> {
  return withCronStorageDirectory(workspacePath, create, async ({
    directory: bound, workspaceIdentity, lockDirectory, verify,
  }) => {
    return operation({
      directory: bound,
      workspaceIdentity,
      lockDirectory,
      async read() {
        return withRegularChild(bound, CRON_STORAGE_NAME, { maximumBytes: MAX_CRON_FILE_BYTES }, async (file) => {
          assertCronRecordOwned(file.snapshot, file.path);
          return (await readConfinedFile(file)).toString("utf8");
        });
      },
      async write(data) {
        if (!create) throw new Error("Cron storage was opened for reading");
        const path = join(bound.operationPath, CRON_STORAGE_NAME);
        const temporaryFlags = process.platform === "win32"
          ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag()
          : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
        let written: BigIntStats | undefined;
        const verifyWrittenFile = async (candidate: string) => {
          const current = await lstat(candidate, { bigint: true });
          if (written === undefined || !current.isFile() || current.nlink !== 1n ||
              !sameIdentity(written, current)) {
            throw new Error("Cron temporary publication file was replaced or linked");
          }
          assertCronRecordOwned(current, candidate);
        };
        await writeDurableAtomicFile(path, `${path}.${randomUUID()}.tmp`, data, 0o600, {
          mkdir: verify,
          openTemporary: (temporary, mode) => open(temporary, temporaryFlags, mode),
          write: async (handle, bytes) => { await (handle as FileHandle).writeFile(bytes); },
          sync: (handle) => (handle as FileHandle).sync(),
          close: async (handle) => {
            try { written = await (handle as FileHandle).stat({ bigint: true }); }
            finally { await (handle as FileHandle).close(); }
          },
          rename: async (from, to) => {
            await verify();
            initializeWindowsCronFile(from);
            await verifyWrittenFile(from);
            await rename(from, to);
            // These checks guard acknowledgement against a substituted
            // basename. POSIX descriptor roots confine the write; Windows
            // rechecks the private ACL and the published inode.
            initializeWindowsCronFile(to);
            await verifyWrittenFile(to);
          },
          syncDirectory: async () => {
            if (process.platform === "win32") await syncWindowsCronDirectory(bound.operationPath);
            else await bound.handle!.sync();
            await verify();
          },
          remove: async (temporary) => { await rm(temporary, { force: true }); },
        });
      },
    });
  }, expectedWorkspaceIdentity);
}

export async function acquireCronStorageLock(
  storage: CronStorage,
  stripe: "tasks" | number,
  options: LocalSqliteLockOptions,
): Promise<() => void> {
  if (stripe !== "tasks" && (!Number.isInteger(stripe) || stripe < 0 || stripe >= 16)) {
    throw new Error("Invalid cron delivery lock stripe");
  }
  // These paths are reserved from model writes, independent of operator grants.
  // The shared SQLite implementation retains its ownership, ACL, filesystem,
  // sentinel, single-link, and inter-process checks in this trusted namespace.
  const root = dirname(storage.lockDirectory);
  for (const directory of [root, storage.lockDirectory]) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const canonical = await assertLocalPrivateDirectory(directory, options);
    if (canonical !== directory) throw new Error("Cron lock authority was redirected");
  }
  return acquireLocalSqliteLock(join(storage.lockDirectory, `${stripe}.lock.sqlite`), options);
}

function assertCronRecordOwned(info: BigIntStats, path: string): void {
  if (process.platform === "win32") {
    assertWindowsPrivatePathSecurity(path, "file", false);
    return;
  }
  assertOwned(info);
}

function initializeWindowsCronFile(path: string): void {
  if (process.platform !== "win32") return;
  assertWindowsPrivatePathSecurity(path, "file", true);
}

async function syncWindowsCronDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  let syncError: unknown;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) syncError = error;
  }
  if (handle !== undefined) {
    try { await handle.close(); }
    catch (error) {
      syncError ??= error;
    }
  }
  if (syncError !== undefined) throw syncError;
}
