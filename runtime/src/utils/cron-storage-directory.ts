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
 * C# helper the repair loads with `Add-Type`: handle-based opens and
 * descriptor writes. No single quotes (the source is a PowerShell
 * single-quoted literal) and C# 5 only (Windows PowerShell 5.1).
 */
const WINDOWS_REPAIR_HELPER = [
  "using System; using System.ComponentModel; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;",
  "public static class AgencCronRepair {",
  "[StructLayout(LayoutKind.Sequential)] public struct Info { public uint Attributes, Created1, Created2, Accessed1, Accessed2, Written1, Written2, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }",
  "[StructLayout(LayoutKind.Sequential)] struct Text { public ushort Length, MaximumLength; public IntPtr Buffer; }",
  "[StructLayout(LayoutKind.Sequential)] struct Target { public int Length; public IntPtr Root, Name; public uint Flags; public IntPtr Descriptor, Quality; }",
  "[StructLayout(LayoutKind.Sequential)] struct Result { public IntPtr Status, Information; }",
  "[DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);",
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);",
  "[DllImport(\"advapi32.dll\", SetLastError = true)] static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint information, byte[] descriptor);",
  "[DllImport(\"ntdll.dll\")] static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref Target target, out Result result, IntPtr size, uint attributes, uint share, uint disposition, uint options, IntPtr extra, uint extraLength);",
  "[DllImport(\"ntdll.dll\")] static extern int RtlNtStatusToDosError(int status);",
  "static Exception Fail(int code, string path) { return new Win32Exception(code, \"Not repaired: \" + path + \" (\" + new Win32Exception(code).Message + \")\"); }",
  // READ_CONTROL | WRITE_DAC | WRITE_OWNER | SYNCHRONIZE | FILE_READ_ATTRIBUTES (+ FILE_TRAVERSE for the folder);
  // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT: a link at the path is opened, never followed.
  "public static SafeFileHandle OpenFolder(string path) { SafeFileHandle handle = CreateFileW(path, 0x1E00A0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero); if (handle.IsInvalid) throw Fail(Marshal.GetLastWin32Error(), path); return handle; }",
  // Opened relative to the folder handle (FILE_OPEN, FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT): it is an entry of that very folder.
  "public static SafeFileHandle OpenChild(SafeFileHandle folder, string name, string path) { Text text = new Text(); text.Length = (ushort)(name.Length * 2); text.MaximumLength = text.Length; text.Buffer = Marshal.StringToHGlobalUni(name); IntPtr textPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Text))); try { Marshal.StructureToPtr(text, textPointer, false); Target target = new Target(); target.Length = Marshal.SizeOf(typeof(Target)); target.Root = folder.DangerousGetHandle(); target.Name = textPointer; target.Flags = 0x40; SafeFileHandle handle; Result result; int status = NtCreateFile(out handle, 0x1E0080, ref target, out result, IntPtr.Zero, 0, 7, 1, 0x200020, IntPtr.Zero, 0); if (status == unchecked((int)0xC0000034)) return null; if (status < 0) throw Fail(RtlNtStatusToDosError(status), path); return handle; } finally { Marshal.FreeHGlobal(textPointer); Marshal.FreeHGlobal(text.Buffer); } }",
  "public static Info Describe(SafeFileHandle handle, string path) { Info info; if (!GetFileInformationByHandle(handle, out info)) throw Fail(Marshal.GetLastWin32Error(), path); return info; }",
  // OWNER | DACL | PROTECTED_DACL on the open handle only (NtSetSecurityObject): nothing is propagated to children.
  "public static void Protect(SafeFileHandle handle, byte[] descriptor, string path) { if (!SetKernelObjectSecurity(handle, 0x80000005, descriptor)) throw Fail(Marshal.GetLastWin32Error(), path); }",
  "}",
].join(" ");

/**
 * Minimal PowerShell repair for one `.agenc` (Windows PowerShell 5.1 and
 * PowerShell 7). It changes at most two objects: the `.agenc` directory
 * itself and, if present, its `scheduled_tasks.json`. Each gets the
 * descriptor `workflow-private-path.ts` writes: owner = current user,
 * protected DACL, one allow FullControl entry for that user ((OI)(CI) on
 * the directory so cron's new files inherit it). Other entries in `.agenc`
 * keep their current ACLs, and nothing is walked.
 *
 * Containment does not rest on skipping links. `.agenc` is opened once
 * with FILE_FLAG_OPEN_REPARSE_POINT, and its type, reparse attribute and
 * file ID are read from that handle; the descriptor is written through the
 * same handle with `SetKernelObjectSecurity`, so a path swapped after the
 * open cannot redirect the write. The task file is opened relative to that
 * directory handle (NtCreateFile with RootDirectory, FILE_OPEN_REPARSE_POINT)
 * and is written only when the handle shows a regular file with one link.
 * `.agenc` is reopened at the end and must have the same volume serial and
 * file ID. `Set-Acl`, .NET `SetAccessControl` and `icacls` are not used:
 * they go through `SetNamedSecurityInfo`, which also rewrites inherited
 * entries of existing children (on Windows 11 it changed an outside file
 * hard-linked into `.agenc`), and `icacls /T` follows junctions.
 *
 * Remaining race: whatever directory is at the path when it is opened is
 * the one made private. Someone who can rename entries in the project
 * folder could put their own real directory there first; it is then made
 * private to the current user, and the final identity check reports a
 * later swap. The script stops at the first error.
 *
 * The path is a PowerShell single-quoted literal; PowerShell also treats
 * U+2018-U+201B as single quotes, so those are doubled too.
 */
export function windowsCronRepairCommand(directory: string): string {
  const literal = `'${directory.replace(/['\u2018\u2019\u201A\u201B]/gu, (quote) => quote + quote)}'`;
  return [
    "& { $ErrorActionPreference = 'Stop'",
    `$root = ${literal}`,
    `Add-Type -TypeDefinition '${WINDOWS_REPAIR_HELPER}'`,
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$descriptor = { param($isFolder) if ($isFolder) { $acl = New-Object Security.AccessControl.DirectorySecurity; $inherit = 'ContainerInherit, ObjectInherit' } else { $acl = New-Object Security.AccessControl.FileSecurity; $inherit = 'None' }; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow'))); ,$acl.GetSecurityDescriptorBinaryForm() }",
    "$link = 0x400",
    "$folder = 0x10",
    "$task = $root + '\\scheduled_tasks.json'",
    "$dir = [AgencCronRepair]::OpenFolder($root)",
    "try { $id = [AgencCronRepair]::Describe($dir, $root); " +
      "if (($id.Attributes -band $link) -ne 0 -or ($id.Attributes -band $folder) -eq 0) { throw \"Not repaired: $root is a junction, a symbolic link or not a directory. Remove it instead.\" }; " +
      "[AgencCronRepair]::Protect($dir, (& $descriptor $true), $root); " +
      "$file = [AgencCronRepair]::OpenChild($dir, 'scheduled_tasks.json', $task); " +
      "if ($file) { try { $info = [AgencCronRepair]::Describe($file, $task); " +
        "if (($info.Attributes -band ($link -bor $folder)) -ne 0 -or $info.Links -ne 1) { throw \"Not repaired: $task is a link, a hard-linked file or not a regular file. Remove or replace it, then run this again.\" }; " +
        "[AgencCronRepair]::Protect($file, (& $descriptor $false), $task) } finally { $file.Dispose() } }; " +
      "$again = [AgencCronRepair]::OpenFolder($root); try { $now = [AgencCronRepair]::Describe($again, $root) } finally { $again.Dispose() }; " +
      "if ($now.Volume -ne $id.Volume -or $now.IndexHigh -ne $id.IndexHigh -or $now.IndexLow -ne $id.IndexLow) { throw \"Not repaired: $root was replaced during the repair. Check it, then run this again.\" } " +
      "} finally { $dir.Dispose() }",
    "\"Repaired $root and its task file; other entries in it keep their ACLs.\" }",
  ].join("; ");
}

/** Who loses access when the repair replaces `.agenc`'s ACL. */
const WINDOWS_REPAIR_ACCESS_LOSS =
  "This replaces the ACL of that directory and task file with one full-control entry for the current user, " +
  "so every other account loses access to them: SYSTEM, Administrators, Users, Authenticated Users, Everyone, " +
  "sandbox or AppContainer groups such as CodexSandboxUsers, and any other explicit entries " +
  "(for example, backup or antivirus software running as SYSTEM can no longer list the directory or read the task file). " +
  "Other entries in the directory keep their current ACLs, links are refused, nothing outside it is changed, " +
  "and the script stops at the first error.";

function windowsRepairAdvice(directory: string, extra = ""): string {
  return `To make ${directory} itself and its scheduled_tasks.json private to the current user, ` +
    `run this in PowerShell${extra}, then retry. ${WINDOWS_REPAIR_ACCESS_LOSS} Command: ` +
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
    const where = failure.reason === "NTFS is required"
      ? `${directory} is on a volume that is not NTFS (for example a ReFS Dev Drive, FAT32 or exFAT)`
      : `${directory} is a network or device path`;
    return fail(
      `Durable cron storage on Windows requires a local NTFS volume, and ${where}. ` +
        "This is a platform limitation that no permission change can fix; its permissions were left unchanged. " +
        "Move the project to a local NTFS volume, or schedule the task with durable:false.",
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
