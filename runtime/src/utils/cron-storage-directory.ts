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

/** Windows `.agenc` (or its task file) failed the private-ACL check and was left unchanged. */
export class CronStorageAclError extends Error {
  readonly code = "CRON_STORAGE_UNSAFE_ACL";
  constructor(message: string, readonly directory: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CronStorageAclError";
  }
}

// Reasons thrown by the PowerShell verifier in `workflow-private-path.ts`.
const WINDOWS_ACL_REASONS = [
  "inherited ACL is unsupported",
  "path owner is not the current user",
  "inherited ACE is unsupported",
  "deny ACE is unsupported",
  "foreign ACE is unsupported",
  "current-user full-control ACE is missing",
] as const;
const WINDOWS_UNSUPPORTED_VOLUME_REASONS = [
  "NTFS is required",
  "network and device paths are unsupported",
] as const;
const WINDOWS_LINK_REASONS = [
  "reparse points are unsupported",
  "path role does not match its type",
] as const;
const DENIED_CODES = new Set(["EACCES", "EPERM"]);

/** First verifier reason found in a cause chain, from a message or PowerShell stderr. */
function windowsPrivatePathReason(error: unknown): string | undefined {
  const known = [...WINDOWS_ACL_REASONS, ...WINDOWS_UNSUPPORTED_VOLUME_REASONS, ...WINDOWS_LINK_REASONS];
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    const candidate = current as { message?: unknown; stderr?: unknown; cause?: unknown };
    const texts = [candidate.message, candidate.stderr].map((value) =>
      Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "");
    for (const text of texts) {
      const reason = known.find((entry) => text.includes(entry));
      if (reason !== undefined) return reason;
    }
    current = candidate.cause;
  }
  return undefined;
}

/** Whether the ACL verifier itself (not a link or file-type check) failed somewhere in the chain. */
function hasWindowsVerifierFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if ((current as { name?: unknown }).name === "WindowsPrivatePathSecurityError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * How a Windows `.agenc` or task-file check failed. Only `acl` (the verifier
 * named an ACL reason) and `denied` (EACCES / EPERM) get the ACL repair.
 */
export type WindowsCronFailure =
  | { readonly kind: "acl"; readonly reason: string }
  | { readonly kind: "volume"; readonly reason: string }
  | { readonly kind: "link" }
  | { readonly kind: "denied"; readonly code: string }
  | { readonly kind: "unknown" };

export function classifyWindowsCronFailure(error: unknown): WindowsCronFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && DENIED_CODES.has(code)) return { kind: "denied", code };
  const reason = windowsPrivatePathReason(error);
  if (reason !== undefined) {
    if ((WINDOWS_UNSUPPORTED_VOLUME_REASONS as readonly string[]).includes(reason)) return { kind: "volume", reason };
    if ((WINDOWS_LINK_REASONS as readonly string[]).includes(reason)) return { kind: "link" };
    if (hasWindowsVerifierFailure(error) || (WINDOWS_ACL_REASONS as readonly string[]).includes(reason)) {
      return { kind: "acl", reason };
    }
  }
  // `withRegularChild` reports a symbolic link, a hard-linked file, or a
  // non-file as CHILD_UNSAFE without running the ACL verifier.
  if (code === "CHILD_UNSAFE" && !hasWindowsVerifierFailure(error)) return { kind: "link" };
  return { kind: "unknown" };
}

/**
 * PowerShell repair for one `.agenc` directory (Windows PowerShell 5.1 and
 * PowerShell 7). It refuses a `.agenc` that is itself a junction or symbolic
 * link, then walks the tree with an explicit stack. A directory is made
 * private before its entries are listed, so nobody else can add or swap an
 * entry while the walk is inside it. Entries that are reparse points
 * (junctions, symbolic links) are skipped and never entered, and files with
 * more than one hard link are skipped, so nothing outside `.agenc` is
 * changed. Every other directory and file gets the descriptor
 * `workflow-private-path.ts` writes: owner = current user, protected DACL,
 * one allow FullControl entry for that user ((OI)(CI) on directories). The
 * script stops at the first error.
 *
 * Descriptors are written with `SetFileSecurityW`, which changes only the
 * named object. `Set-Acl`, .NET `SetAccessControl` and `icacls` all go
 * through `SetNamedSecurityInfo`, which also rewrites the inherited entries
 * of every existing child, so a hard link under `.agenc` to an outside file
 * would change that file (seen on Windows 11). `icacls /T` also follows
 * junctions, and `/L` covers only symbolic links.
 *
 * The path is a PowerShell single-quoted literal; PowerShell also treats
 * U+2018-U+201B as single quotes, so those are doubled too.
 */
export function windowsCronRepairCommand(directory: string): string {
  const literal = `'${directory.replace(/['\u2018\u2019\u201A\u201B]/gu, (quote) => quote + quote)}'`;
  return [
    "& { $ErrorActionPreference = 'Stop'",
    `$root = ${literal}`,
    "$link = [IO.FileAttributes]::ReparsePoint",
    "$folder = [IO.FileAttributes]::Directory",
    "$a = [IO.File]::GetAttributes($root)",
    "if (($a -band $link) -ne 0 -or ($a -band $folder) -eq 0) { throw \"Not repaired: $root is a junction, a symbolic link or not a directory. Remove it instead.\" }",
    "Add-Type -Namespace AgencCronRepair -Name Native -MemberDefinition '[DllImport(\"advapi32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetFileSecurityW(string path, int info, byte[] descriptor);'",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$private = { param($path, $isFolder) if ($isFolder) { $acl = New-Object Security.AccessControl.DirectorySecurity; $inherit = 'ContainerInherit, ObjectInherit' } else { $acl = New-Object Security.AccessControl.FileSecurity; $inherit = 'None' }; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow'))); if (-not [AgencCronRepair.Native]::SetFileSecurityW($path, 0x80000005, $acl.GetSecurityDescriptorBinaryForm())) { $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); $why = (New-Object ComponentModel.Win32Exception($code)).Message; throw (New-Object ComponentModel.Win32Exception($code, \"Not repaired: $path ($why)\")) } }",
    "& $private $root $true",
    "$todo = New-Object Collections.Stack",
    "$todo.Push($root)",
    "$skipped = 0",
    "while ($todo.Count -gt 0) { foreach ($path in [IO.Directory]::GetFileSystemEntries($todo.Pop())) { $a = [IO.File]::GetAttributes($path); if (($a -band $link) -ne 0) { Write-Warning \"Skipped link: $path\"; $skipped++ } elseif (($a -band $folder) -ne 0) { & $private $path $true; $todo.Push($path) } elseif ((Get-Item -LiteralPath $path -Force).LinkType -eq 'HardLink') { Write-Warning \"Skipped hard-linked file: $path\"; $skipped++ } else { & $private $path $false } } }",
    "\"Repaired $root ($skipped links skipped)\" }",
  ].join("; ");
}

function windowsRepairAdvice(directory: string, extra = ""): string {
  return `To make ${directory} and everything in it private to the current user ` +
    "(junctions, symbolic links and hard-linked files inside it are skipped, its parent is not changed, " +
    `and the script stops at the first error), run this in PowerShell${extra}, then retry: ` +
    windowsCronRepairCommand(directory);
}

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A rejected Windows cron directory or task file, left unchanged. The ACL
 * repair is offered only when the ACL verifier named an ACL problem or the
 * path could not be inspected (EACCES / EPERM). A link or non-regular task
 * file is to be removed or replaced; an unsupported volume has no repair.
 * `inspected` is the path that failed when it is not `directory` itself.
 */
export function windowsCronAclError(
  directory: string,
  cause: unknown,
  state: "existing" | "created" | "inaccessible" | "record" = "existing",
  inspected: string = directory,
): CronStorageAclError {
  const failure = classifyWindowsCronFailure(cause);
  const fail = (message: string) => new CronStorageAclError(message, directory, { cause });
  if (failure.kind === "volume") {
    return fail(
      `${OWNERSHIP_ERROR}: ${directory} is on a volume that Windows durable cron storage does not support ` +
        `(${failure.reason}). Its permissions were left unchanged. Keep the project on a local NTFS volume, ` +
        "or schedule the task with durable:false.",
    );
  }
  if (state === "inaccessible" || failure.kind === "denied") {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    return fail(
      `${OWNERSHIP_ERROR}: ${inspected} could not be inspected${code === undefined ? "" : ` (${code})`}, ` +
        `and it was left unchanged. ${windowsRepairAdvice(directory, " (elevated if access is denied)")}`,
    );
  }
  if (failure.kind === "link") {
    return fail(
      `${OWNERSHIP_ERROR}: ${inspected} is a symbolic link, a junction, a hard-linked file or not a regular ` +
        "entry, and it was left unchanged. Remove it, or replace it with a regular file or directory, then retry.",
    );
  }
  if (state === "created") {
    const reason = failure.kind === "acl" ? ` (${failure.reason})` : ` (${causeText(cause)})`;
    const repair = failure.kind === "acl" ? ` ${windowsRepairAdvice(directory)}` : "";
    return fail(
      `${OWNERSHIP_ERROR}: ${directory} was created, but it could not be made private to the current user${reason}. ` +
        `Remove that directory, or repair it, then retry.${repair}`,
    );
  }
  if (failure.kind !== "acl") {
    return fail(
      `${OWNERSHIP_ERROR}: ${inspected} could not be verified as private to the current user ` +
        `(${causeText(cause)}), and it was left unchanged.`,
    );
  }
  if (state === "record") {
    return fail(
      `${causeText(cause)} (${failure.reason}). The task file was left unchanged. ${windowsRepairAdvice(directory)}`,
    );
  }
  return fail(
    `${OWNERSHIP_ERROR}: ${directory} has a Windows ACL that is not private to the current user (${failure.reason}), ` +
      `and it was left unchanged. ${windowsRepairAdvice(directory)}`,
  );
}

/**
 * Windows has no traversable directory descriptor. `.agenc` is the private
 * root. This operation initializes that ACL only when it created the
 * directory; an existing directory is validated and left unchanged. Reads
 * and writes then stay inside `windows-private-path`. The project workspace
 * keeps its inherited DACL. Publication rechecks the workspace device and
 * inode, and both the lexical and canonical `.agenc` directories must stay
 * the ACL-checked inode so a junction or swapped path cannot redirect the root.
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
  const opened = await openWindowsAgencDirectory(directory, create);
  if (opened === undefined) return undefined;
  const directoryInfo = opened.info;
  await assertRealDirectory(workspacePathResolved, workspaceInfo);
  // No await between this identity check and the ACL write or check.
  await assertRealDirectory(directory, directoryInfo);
  ensureWindowsPrivateDirectory(directory, opened.created);
  try {
    return await withConfinedDirectory(directory, WINDOWS_STORAGE_POLICY, async (bound) => {
      await bound.verify();
      // realpath follows Windows junctions. The confined root is usable only
      // when that result is still the directory whose ACL was just checked.
      const boundInfo = await assertRealDirectory(bound.canonicalPath, directoryInfo);
      await assertRealDirectory(directory, directoryInfo);
      const verify = async () => {
        await bound.verify();
        await assertRealDirectory(workspacePathResolved, workspaceInfo);
        await assertRealDirectory(bound.canonicalPath, boundInfo);
        await assertRealDirectory(directory, directoryInfo);
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

async function openWindowsAgencDirectory(
  directory: string,
  create: boolean,
): Promise<{ readonly info: BigIntStats; readonly created: boolean } | undefined> {
  let info: BigIntStats | undefined;
  try {
    info = await lstat(directory, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw windowsCronAclError(directory, error, "inaccessible");
    if (code !== "ENOENT") throw error;
    if (!create) return undefined;
  }
  // An existing directory is never proof that this call may change its ACL.
  // `create: true` only allows the missing-directory path below.
  let created = false;
  if (info === undefined) {
    created = await createWindowsAgencDirectory(directory);
    info = await lstat(directory, { bigint: true });
  }
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(OWNERSHIP_ERROR);
  }
  return { info, created };
}

async function createWindowsAgencDirectory(directory: string): Promise<boolean> {
  // Non-recursive mkdir resolves with `undefined` on success, so that return
  // value is not proof of creation. `EEXIST` means another caller created
  // `.agenc` and this caller must only validate it. Recursive mkdir is not
  // used: it returns the first created path, or `undefined` when the
  // directory already existed.
  try {
    await mkdir(directory, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

function ensureWindowsPrivateDirectory(path: string, created: boolean): void {
  if (created) {
    // A failed first initialization leaves `.agenc` behind. Later calls see
    // it as existing and only validate, so this error names the repair.
    try {
      assertWindowsPrivatePathSecurity(path, "directory", true);
    } catch (cause) {
      throw windowsCronAclError(path, cause, "created");
    }
  }
  try {
    assertWindowsPrivatePathSecurity(path, "directory", false);
  } catch (cause) {
    throw windowsCronAclError(path, cause, created ? "created" : "existing");
  }
}
