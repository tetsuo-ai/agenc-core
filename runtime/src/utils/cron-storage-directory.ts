import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { assertWindowsPrivatePathSecurity } from "../agents/workflow-private-path.js";
import { sameIdentity, withConfinedDirectory, type ConfinedDirectory, type ConfinedIoPolicy } from "../fs/descriptor-confined-io.js";
import { cronLockAuthorityRoot } from "../sandbox/cron-authority-protection.js";
import { isWithinAuthorityPath } from "../sandbox/desktop-authority-protection.js";

export const CRON_STORAGE_NAME = "scheduled_tasks.json";
const WRITE_POLICY: ConfinedIoPolicy = {
  hardLinks: "reject", privateDirectory: false, privateFile: false,
  unavailableAlias: "reject",
};
const READ_POLICY: ConfinedIoPolicy = WRITE_POLICY;
const WINDOWS_STORAGE_POLICY: ConfinedIoPolicy = {
  hardLinks: "reject",
  privateDirectory: true,
  privateFile: true,
  unavailableAlias: "windows-private-path",
  verifyWindowsPrivatePath: (path, role) => {
    assertWindowsPrivatePathSecurity(path, role, false);
  },
};

export function assertOwned(info: BigIntStats): void {
  if (typeof process.getuid !== "function" || info.uid !== BigInt(process.getuid()) ||
      (info.mode & 0o022n) !== 0n) {
    throw new Error("Cron storage must be owned by the current user and not writable by other users");
  }
}

export interface CronStorageDirectory {
  readonly directory: ConfinedDirectory;
  readonly workspaceIdentity: string;
  readonly lockDirectory: string;
  verify(): Promise<void>;
}

/** Shared descriptor/ownership boundary for storage and the startup absence probe. */
export async function withCronStorageDirectory<Result>(
  workspacePath: string,
  create: boolean,
  operation: (storage: CronStorageDirectory) => Promise<Result>,
  expectedWorkspaceIdentity?: string,
): Promise<Result | undefined> {
  const workspacePathResolved = await realpath(workspacePath);
  const lockRoot = cronLockAuthorityRoot();
  try {
    const info = await lstat(lockRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Cron lock authority must not contain redirected directories");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (isWithinAuthorityPath(lockRoot, workspacePathResolved) ||
      isWithinAuthorityPath(workspacePathResolved, lockRoot)) {
    throw new Error("Cron lock authority must be outside the workspace");
  }
  if (process.platform === "win32") {
    return withWindowsCronStorageDirectory(
      workspacePathResolved, lockRoot, create, operation, expectedWorkspaceIdentity,
    );
  }
  const policy = create ? WRITE_POLICY : READ_POLICY;
  return withConfinedDirectory(workspacePathResolved, policy, async (workspace) => {
    const identity = await workspace.handle!.stat({ bigint: true });
    assertOwned(identity);
    // Device/inode identity keeps aliases and renames on one cross-home lock.
    const key = createHash("sha256").update(`${identity.dev}:${identity.ino}`).digest("hex");
    if (expectedWorkspaceIdentity !== undefined && key !== expectedWorkspaceIdentity) {
      throw new Error("Cron workspace identity changed during a delivery claim");
    }
    const directory = join(workspace.operationPath, ".agenc");
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await workspace.verify();
    try {
      return await withConfinedDirectory(directory, policy, async (bound) => {
        assertOwned(await bound.handle!.stat({ bigint: true }));
        const verify = async () => {
          await workspace.verify();
          await bound.verify();
          assertOwned(await bound.handle!.stat({ bigint: true }));
        };
        return operation({
          directory: bound,
          workspaceIdentity: key,
          lockDirectory: join(lockRoot, key),
          verify,
        });
      });
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  });
}

const OWNERSHIP_ERROR = "Cron storage must be owned by the current user and not writable by other users";

/**
 * Windows has no traversable directory descriptor. `.agenc` is the private
 * root: its ACL is initialized by the workflow handoff helper, then reads
 * and writes stay inside `windows-private-path`. The project workspace keeps
 * its inherited DACL; publication rechecks that directory's device and inode
 * so a swapped workspace cannot redirect the private root.
 */
async function withWindowsCronStorageDirectory<Result>(
  workspacePathResolved: string,
  lockRoot: string,
  create: boolean,
  operation: (storage: CronStorageDirectory) => Promise<Result>,
  expectedWorkspaceIdentity: string | undefined,
): Promise<Result | undefined> {
  const workspaceInfo = await assertRealDirectory(workspacePathResolved);
  const key = createHash("sha256").update(`${workspaceInfo.dev}:${workspaceInfo.ino}`).digest("hex");
  if (expectedWorkspaceIdentity !== undefined && key !== expectedWorkspaceIdentity) {
    throw new Error("Cron workspace identity changed during a delivery claim");
  }
  const directory = join(workspacePathResolved, ".agenc");
  let createdInfo: BigIntStats | undefined;
  try {
    createdInfo = await lstat(directory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return undefined;
  }
  if (createdInfo === undefined) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    createdInfo = await lstat(directory, { bigint: true });
  }
  if (!createdInfo.isDirectory() || createdInfo.isSymbolicLink()) {
    throw new Error(OWNERSHIP_ERROR);
  }
  await assertRealDirectory(workspacePathResolved, workspaceInfo);
  ensureWindowsPrivateDirectory(directory);
  try {
    return await withConfinedDirectory(directory, WINDOWS_STORAGE_POLICY, async (bound) => {
      await bound.verify();
      const boundInfo = await lstat(bound.canonicalPath, { bigint: true });
      if (!boundInfo.isDirectory() || boundInfo.isSymbolicLink()) throw new Error(OWNERSHIP_ERROR);
      const verify = async () => {
        await bound.verify();
        await assertRealDirectory(workspacePathResolved, workspaceInfo);
        await assertRealDirectory(bound.canonicalPath, boundInfo);
      };
      return operation({
        directory: bound,
        workspaceIdentity: key,
        lockDirectory: join(lockRoot, key),
        verify,
      });
    });
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertRealDirectory(path: string, expected?: BigIntStats): Promise<BigIntStats> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (expected !== undefined && !sameIdentity(expected, info))) {
    throw new Error(OWNERSHIP_ERROR);
  }
  return info;
}

function ensureWindowsPrivateDirectory(path: string): void {
  try {
    assertWindowsPrivatePathSecurity(path, "directory", false);
    return;
  } catch {
    // Project metadata commonly inherits the profile ACL. Tighten that
    // directory in place, then require the verifier to accept it.
  }
  assertWindowsPrivatePathSecurity(path, "directory", true);
  assertWindowsPrivatePathSecurity(path, "directory", false);
}
