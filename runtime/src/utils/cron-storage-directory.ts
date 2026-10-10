import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWindowsPrivatePathSecurity, runWindowsSecurityScript } from "../agents/workflow-private-path.js";
import { sameIdentity, withConfinedDirectory, type ConfinedDirectory, type ConfinedIoPolicy } from "../fs/descriptor-confined-io.js";
import { cronLockAuthorityRoot } from "../sandbox/cron-authority-protection.js";
import { MAX_CRON_FILE_BYTES } from "./cron-delivery-state.js";
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
  /** The verified `.agenc` identity, rechecked immediately before it is returned. */
  verify(): Promise<BigIntStats>;
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
          const current = await bound.handle!.stat({ bigint: true });
          assertOwned(current);
          return current;
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
// Thrown by the created-directory initialization below.
const WINDOWS_REPLACED_REASON = "directory identity changed before its ACL was set";
const WINDOWS_ADD_TYPE_REASON = "Add-Type is unavailable";
const WINDOWS_PUBLICATION_REASONS = [
  "publication directory changed before acknowledgement",
  "Cron temporary publication file was replaced or linked",
  "publication write did not match the task bytes",
  "publication target is a link or not a file",
  "invalid publication name",
  "invalid temporary name",
  "publication stage changed",
  "publication fault hook is not a local script path",
  "publication payload exceeds 16777216 bytes",
  "publication create failed",
  "publication write failed",
  "publication flush failed",
  "publication rename failed",
  "publication read failed",
  "publication directory flush failed",
  "publication delete failed",
] as const;
const DENIED_CODES = new Set(["EACCES", "EPERM"]);

/** First verifier reason found in a cause chain, from a message or PowerShell stderr. */
function windowsPrivatePathReason(error: unknown): string | undefined {
  const known = [
    ...WINDOWS_ACL_REASONS, ...WINDOWS_UNSUPPORTED_VOLUME_REASONS, ...WINDOWS_LINK_REASONS, WINDOWS_REPLACED_REASON,
    WINDOWS_ADD_TYPE_REASON, ...WINDOWS_PUBLICATION_REASONS,
  ];
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

/**
 * The file system the verifier named in `NTFS is required (<DriveFormat>)`.
 * `$` and parentheses are excluded so PowerShell's echo of the throwing
 * source line (`($($drive.DriveFormat))`) never matches.
 */
function windowsDriveFormat(error: unknown): string | undefined {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    const candidate = current as { message?: unknown; stderr?: unknown; cause?: unknown };
    for (const value of [candidate.message, candidate.stderr]) {
      const text = Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
      const format = /NTFS is required \(([A-Za-z0-9][A-Za-z0-9 ._-]{0,31})\)/u.exec(text)?.[1]?.trim();
      if (format !== undefined && format !== "") return format;
    }
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Why `Add-Type` was unavailable to the created-directory initialization:
 * the PowerShell language mode (`ConstrainedLanguage`, ...) or the .NET
 * exception type `Add-Type` threw. `$` is excluded so PowerShell's echo of
 * the throwing source line never matches.
 */
function windowsAddTypeDetail(error: unknown): string | undefined {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    const candidate = current as { message?: unknown; stderr?: unknown; cause?: unknown };
    for (const value of [candidate.message, candidate.stderr]) {
      const text = Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
      const detail = /Add-Type is unavailable \(([A-Za-z][A-Za-z0-9]{0,63})\)/u.exec(text)?.[1];
      if (detail !== undefined) return detail;
    }
    current = candidate.cause;
  }
  return undefined;
}

/** The NTSTATUS / Win32 code a failed publication system call reported, e.g. `NTSTATUS 0xC000000D, Win32 error 87`. */
function windowsPublicationCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    const candidate = current as { message?: unknown; stderr?: unknown; cause?: unknown };
    for (const value of [candidate.message, candidate.stderr]) {
      const text = Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
      const code = /publication [a-z ]{1,24} failed \(((?:NTSTATUS 0x[0-9A-F]{8}, )?Win32 error \d{1,10})\)/u.exec(text)?.[1];
      if (code !== undefined) return code;
    }
    current = candidate.cause;
  }
  return undefined;
}

const WINDOWS_PUBLICATION_OUTCOMES = [
  "previous-record-restored", "previous-record-not-restored", "previous-record-untouched", "new-record-in-place",
] as const;

/** Which record the publication script left behind when it failed (marker appended by the script). */
function windowsPublicationOutcome(error: unknown): (typeof WINDOWS_PUBLICATION_OUTCOMES)[number] | undefined {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    const candidate = current as { message?: unknown; stderr?: unknown; cause?: unknown };
    for (const value of [candidate.message, candidate.stderr]) {
      const text = Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
      const found = WINDOWS_PUBLICATION_OUTCOMES.find((token) => text.includes(`[${token}]`));
      if (found !== undefined) return found;
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
  | { readonly kind: "replaced" }
  | { readonly kind: "addtype" }
  | { readonly kind: "publication"; readonly reason: string }
  | { readonly kind: "denied"; readonly code: string }
  | { readonly kind: "unknown" };

export function classifyWindowsCronFailure(error: unknown): WindowsCronFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && DENIED_CODES.has(code)) return { kind: "denied", code };
  const reason = windowsPrivatePathReason(error);
  if (reason !== undefined) {
    if ((WINDOWS_UNSUPPORTED_VOLUME_REASONS as readonly string[]).includes(reason)) return { kind: "volume", reason };
    if ((WINDOWS_LINK_REASONS as readonly string[]).includes(reason)) return { kind: "link" };
    if (reason === WINDOWS_REPLACED_REASON) return { kind: "replaced" };
    if (reason === WINDOWS_ADD_TYPE_REASON) return { kind: "addtype" };
    if ((WINDOWS_PUBLICATION_REASONS as readonly string[]).includes(reason)) return { kind: "publication", reason };
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
 * C# helper loaded with `Add-Type` by both the repair command and the
 * first-time initialization of a created `.agenc`: handle-based opens and
 * descriptor writes. No single quotes (the source is a PowerShell
 * single-quoted literal) and C# 5 only (Windows PowerShell 5.1).
 */
const WINDOWS_REPAIR_HELPER = [
  "using System; using System.ComponentModel; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;",
  "public static class AgencCronRepair {",
  "[StructLayout(LayoutKind.Sequential)] public struct Info { public uint Attributes, Created1, Created2, Accessed1, Accessed2, Written1, Written2, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; public ulong Index { get { return ((ulong)IndexHigh << 32) | IndexLow; } } }",
  "[StructLayout(LayoutKind.Sequential)] struct Text { public ushort Length, MaximumLength; public IntPtr Buffer; }",
  "[StructLayout(LayoutKind.Sequential)] struct Target { public int Length; public IntPtr Root, Name; public uint Flags; public IntPtr Descriptor, Quality; }",
  "[StructLayout(LayoutKind.Sequential)] struct Result { public IntPtr Status, Information; }",
  "[DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);",
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);",
  "[DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder name, int nameSize, out uint serial, out uint length, out uint flags, StringBuilder system, int systemSize);",
  "[DllImport(\"advapi32.dll\", SetLastError = true)] static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint information, byte[] descriptor);",
  "[DllImport(\"ntdll.dll\")] static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref Target target, out Result result, IntPtr size, uint attributes, uint share, uint disposition, uint options, IntPtr extra, uint extraLength);",
  "[DllImport(\"ntdll.dll\")] static extern int RtlNtStatusToDosError(int status);",
  "public static string Prefix = \"Not repaired: \";",
  "static Exception Fail(int code, string path) { return new Win32Exception(code, Prefix + path + \" (\" + new Win32Exception(code).Message + \")\"); }",
  // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT: a link at the path is opened, never followed.
  "static SafeFileHandle Open(string path, uint access) { SafeFileHandle handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero); if (handle.IsInvalid) throw Fail(Marshal.GetLastWin32Error(), path); return handle; }",
  // READ_CONTROL | WRITE_DAC | WRITE_OWNER | SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_TRAVERSE.
  "public static SafeFileHandle OpenFolder(string path) { return Open(path, 0x1E00A0); }",
  // READ_CONTROL | SYNCHRONIZE | FILE_READ_ATTRIBUTES: enough to read type, identity and file system.
  "public static SafeFileHandle Probe(string path) { return Open(path, 0x120080); }",
  // Opened relative to the folder handle (FILE_OPEN, FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT): it is an entry of that very folder.
  // No data access is requested, so the share mode neither locks the file nor conflicts with a reader; see windowsCronRepairCommand.
  // The three-argument form opens for the descriptor write (READ_CONTROL | WRITE_DAC | WRITE_OWNER | SYNCHRONIZE | FILE_READ_ATTRIBUTES).
  "public static SafeFileHandle OpenChild(SafeFileHandle folder, string name, string path) { return OpenChild(folder, name, path, 0x1E0080); }",
  "public static SafeFileHandle OpenChild(SafeFileHandle folder, string name, string path, uint access) { Text text = new Text(); text.Length = (ushort)(name.Length * 2); text.MaximumLength = text.Length; text.Buffer = Marshal.StringToHGlobalUni(name); IntPtr textPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Text))); try { Marshal.StructureToPtr(text, textPointer, false); Target target = new Target(); target.Length = Marshal.SizeOf(typeof(Target)); target.Root = folder.DangerousGetHandle(); target.Name = textPointer; target.Flags = 0x40; SafeFileHandle handle; Result result; int status = NtCreateFile(out handle, access, ref target, out result, IntPtr.Zero, 0, 7, 1, 0x200020, IntPtr.Zero, 0); if (status == unchecked((int)0xC0000034)) return null; if (status < 0) throw Fail(RtlNtStatusToDosError(status), path); return handle; } finally { Marshal.FreeHGlobal(textPointer); Marshal.FreeHGlobal(text.Buffer); } }",
  "public static Info Describe(SafeFileHandle handle, string path) { Info info; if (!GetFileInformationByHandle(handle, out info)) throw Fail(Marshal.GetLastWin32Error(), path); return info; }",
  // The file system of the volume the handle is on (NTFS, ReFS, FAT32, exFAT, ...).
  "public static string FileSystem(SafeFileHandle handle, string path) { uint serial, length, flags; StringBuilder system = new StringBuilder(261); if (!GetVolumeInformationByHandleW(handle, null, 0, out serial, out length, out flags, system, 261)) throw Fail(Marshal.GetLastWin32Error(), path); return system.ToString(); }",
  // OWNER | DACL | PROTECTED_DACL on the open handle only (NtSetSecurityObject): nothing is propagated to children.
  "public static void Protect(SafeFileHandle handle, byte[] descriptor, string path) { if (!SetKernelObjectSecurity(handle, 0x80000005, descriptor)) throw Fail(Marshal.GetLastWin32Error(), path); }",
  "}",
].join(" ");

/**
 * Publication-only methods. They stay out of the repair command so that
 * command does not grow by the write and rename helpers. The publication
 * script appends them to the same class before Add-Type.
 */
const WINDOWS_PUBLISH_METHODS = [
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool WriteFile(SafeFileHandle handle, IntPtr bytes, int count, out int written, IntPtr overlapped);",
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool ReadFile(SafeFileHandle handle, IntPtr bytes, int count, out int read, IntPtr overlapped);",
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool FlushFileBuffers(SafeFileHandle handle);",
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int cls, IntPtr info, int size);",
  // NtSetInformationFile(FileRenameInformationEx, class 65) binds the rename to the directory handle
  // and replaces the target atomically (the canonical name is never vacated) with FILE_RENAME_REPLACE_IF_EXISTS |
  // FILE_RENAME_POSIX_SEMANTICS, so a reader holding the old file open keeps reading it while the name
  // flips to the new file in one step (#2976 r9 reproducer R1, R2, R4, R6).
  "[DllImport(\"ntdll.dll\")] static extern int NtSetInformationFile(SafeFileHandle handle, out Result result, IntPtr info, int length, int cls);",
  "[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RenameInfo { public uint Flags; public IntPtr RootDirectory; public uint FileNameLength; public char FileName; }",
  "static Exception Broke(string step, int status) { int code = RtlNtStatusToDosError(status); return new Win32Exception(code, \"publication \" + step + \" failed (NTSTATUS 0x\" + status.ToString(\"X8\") + \", Win32 error \" + code + \")\"); }",
  "static Exception Broke(string step) { int code = Marshal.GetLastWin32Error(); return new Win32Exception(code, \"publication \" + step + \" failed (Win32 error \" + code + \")\"); }",
  "public static SafeFileHandle OpenPublishFolder(string path) { return Open(path, 0x1F01E7); }",
  "public static SafeFileHandle CreateNewChild(SafeFileHandle folder, string name) { Text text = new Text(); text.Length = (ushort)(name.Length * 2); text.MaximumLength = text.Length; text.Buffer = Marshal.StringToHGlobalUni(name); IntPtr textPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Text))); try { Marshal.StructureToPtr(text, textPointer, false); Target target = new Target(); target.Length = Marshal.SizeOf(typeof(Target)); target.Root = folder.DangerousGetHandle(); target.Name = textPointer; target.Flags = 0x40; SafeFileHandle handle; Result result; int status = NtCreateFile(out handle, 0x1F0187, ref target, out result, IntPtr.Zero, 0x80, 7, 2, 0x200060, IntPtr.Zero, 0); if (status < 0) throw Broke(\"create\", status); return handle; } finally { Marshal.FreeHGlobal(textPointer); Marshal.FreeHGlobal(text.Buffer); } }",
  "public static void WriteAll(SafeFileHandle handle, byte[] bytes) { if (bytes != null && bytes.Length > 0) { GCHandle pin = GCHandle.Alloc(bytes, GCHandleType.Pinned); try { for (int offset = 0; offset < bytes.Length; ) { int wrote; int count = bytes.Length - offset; if (count > 1048576) count = 1048576; if (!WriteFile(handle, IntPtr.Add(pin.AddrOfPinnedObject(), offset), count, out wrote, IntPtr.Zero)) throw Broke(\"write\"); if (wrote < 1) throw new InvalidOperationException(\"publication write failed (no progress)\"); offset += wrote; } } finally { pin.Free(); } } if (!FlushFileBuffers(handle)) throw Broke(\"flush\"); }",
  "public static byte[] ReadRecord(SafeFileHandle handle, Info info) { if (info.SizeHigh != 0 || info.SizeLow > 16777216) throw new InvalidOperationException(\"publication read failed (previous record too large)\"); int size = (int)info.SizeLow; byte[] data = new byte[size]; if (size == 0) return data; GCHandle pin = GCHandle.Alloc(data, GCHandleType.Pinned); try { for (int offset = 0; offset < size; ) { int got; if (!ReadFile(handle, IntPtr.Add(pin.AddrOfPinnedObject(), offset), size - offset, out got, IntPtr.Zero)) throw Broke(\"read\"); if (got < 1) throw new InvalidOperationException(\"publication read failed (short read)\"); offset += got; } } finally { pin.Free(); } return data; }",
  // The buffer is sizeof(FILE_RENAME_INFORMATION_EX) plus the name bytes, the size ntifs.h requires; offsets come from the layout.
  // Flags = FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS when replacing, POSIX_SEMANTICS alone otherwise.
  "public static void RenameWithin(SafeFileHandle file, SafeFileHandle folder, string name, bool replace) { byte[] text = Encoding.Unicode.GetBytes(name); int size = Marshal.SizeOf(typeof(RenameInfo)) + text.Length; IntPtr buffer = Marshal.AllocHGlobal(size); try { for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0); Marshal.WriteInt32(buffer, (int)Marshal.OffsetOf(typeof(RenameInfo), \"Flags\"), replace ? 0x3 : 0x2); Marshal.WriteIntPtr(buffer, (int)Marshal.OffsetOf(typeof(RenameInfo), \"RootDirectory\"), folder.DangerousGetHandle()); Marshal.WriteInt32(buffer, (int)Marshal.OffsetOf(typeof(RenameInfo), \"FileNameLength\"), text.Length); Marshal.Copy(text, 0, IntPtr.Add(buffer, (int)Marshal.OffsetOf(typeof(RenameInfo), \"FileName\")), text.Length); Result result; int status = NtSetInformationFile(file, out result, buffer, size, 65); if (status < 0) throw Broke(\"rename\", status); } finally { Marshal.FreeHGlobal(buffer); } }",
  // Makes the rename durable, as the POSIX path fsyncs its directory. The handle holds FILE_ADD_FILE (FILE_WRITE_DATA).
  "public static void FlushFolder(SafeFileHandle folder) { if (!FlushFileBuffers(folder)) throw Broke(\"directory flush\"); }",
  "public static void DeleteWhenClosed(SafeFileHandle handle) { IntPtr buffer = Marshal.AllocHGlobal(1); try { Marshal.WriteByte(buffer, 0, 1); if (!SetFileInformationByHandle(handle, 4, buffer, 1)) throw Broke(\"delete\"); } finally { Marshal.FreeHGlobal(buffer); } }",
].join(" ");
const WINDOWS_PUBLISH_HELPER = `${WINDOWS_REPAIR_HELPER.slice(0, -1)} ${WINDOWS_PUBLISH_METHODS}}`;

/**
 * PowerShell script block returning the descriptor both scripts write:
 * owner = current user, protected DACL, one allow FullControl entry for that
 * user ((OI)(CI) on a directory so cron's new files inherit it). The same
 * descriptor `workflow-private-path.ts` writes.
 */
const WINDOWS_PRIVATE_DESCRIPTOR =
  "{ param($isFolder) $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; " +
  "if ($isFolder) { $acl = New-Object Security.AccessControl.DirectorySecurity; $inherit = 'ContainerInherit, ObjectInherit' } " +
  "else { $acl = New-Object Security.AccessControl.FileSecurity; $inherit = 'None' }; " +
  "$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); " +
  "$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow'))); " +
  ",$acl.GetSecurityDescriptorBinaryForm() }";

/**
 * Minimal PowerShell repair for one `.agenc` (Windows PowerShell 5.1 and
 * PowerShell 7). It changes at most two objects: the `.agenc` directory
 * itself and, if present, its `scheduled_tasks.json`. Each gets
 * WINDOWS_PRIVATE_DESCRIPTOR. Other entries in `.agenc` keep their current
 * ACLs, and nothing is walked.
 *
 * Containment does not rest on skipping links. `.agenc` is opened once
 * with FILE_FLAG_OPEN_REPARSE_POINT, and its type, reparse attribute and
 * file ID are read from that handle. The task file is opened relative to
 * that directory handle (NtCreateFile with RootDirectory,
 * FILE_OPEN_REPARSE_POINT) and must be a regular file with one link; a
 * refused or unopenable task file stops the script before anything is
 * written. Only then are both descriptors written through those handles
 * with `SetKernelObjectSecurity`, so a path swapped after the open cannot
 * redirect a write. `.agenc` must be on NTFS (read from its handle) before
 * either write. After the task file's write its link count is read again,
 * and the name `scheduled_tasks.json` is reopened relative to the directory
 * handle (attributes only) and must still be that file (volume serial and
 * file ID) with one link: a same-volume rename keeps the count at one, so
 * only the identity shows that another file now has the name. That case says
 * the file now at the name was not changed. The same file with another link
 * uses the link-count sentence instead: the file was made private, so the
 * message does not say it was left unchanged. A missing name says the name
 * disappeared. None of these print `Repaired`. With no task
 * file at the start, one that appears during the repair also stops it.
 * `.agenc` is reopened at the end and must have the same volume serial and
 * file ID. Every message after the first write starts with "Stopped" and
 * says what is already private. `Set-Acl`, .NET `SetAccessControl` and `icacls` are
 * not used: they go through `SetNamedSecurityInfo`, which also rewrites
 * inherited entries of existing children (on Windows 11 it changed an
 * outside file hard-linked into `.agenc`), and `icacls /T` follows junctions.
 *
 * The task file handle requests no data access, so its share mode does not
 * lock anything: Windows applies share modes only to opens that request
 * read, write or delete access, and on Windows 11 `CreateHardLink` added
 * names to a file held open with share mode 0 (with DELETE or READ_DATA
 * access too), while share mode 0 made the open fail with a sharing
 * violation whenever another process (such as a running AgenC) had the file
 * open. A name added before the file is made private is caught by the link
 * count read after the write; after that, only the current user can open
 * the file to add one.
 *
 * Remaining race: whatever directory is at the path when it is opened is
 * the one made private. Someone who can rename entries in the project
 * folder could put their own real directory there first; it is then made
 * private to the current user, and the final identity check reports a
 * later swap. These checks see changes made before them: an account that
 * opened `.agenc` or the task file before the repair keeps the access that
 * handle was granted until it closes it. The script stops at the first
 * error. Without Full Language Mode (Constrained Language Mode, AppLocker,
 * WDAC) it stops before `Add-Type` and says so.
 *
 * The path is a PowerShell single-quoted literal; PowerShell also treats
 * U+2018-U+201B as single quotes, so those are doubled too.
 */
export function windowsCronRepairCommand(directory: string): string {
  const literal = `'${directory.replace(/['\u2018\u2019\u201A\u201B]/gu, (quote) => quote + quote)}'`;
  return [
    "& { $ErrorActionPreference = 'Stop'",
    `$root = ${literal}`,
    "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw \"Not repaired: this PowerShell runs in $($ExecutionContext.SessionState.LanguageMode) mode and the repair needs Add-Type (Full Language Mode). Nothing was changed.\" }",
    `Add-Type -TypeDefinition '${WINDOWS_REPAIR_HELPER}'`,
    "[AgencCronRepair]::Prefix = 'Not repaired: '",
    `$descriptor = ${WINDOWS_PRIVATE_DESCRIPTOR}`,
    "$link = 0x400",
    "$folder = 0x10",
    "$task = $root + '\\scheduled_tasks.json'",
    "$dir = [AgencCronRepair]::OpenFolder($root)",
    "try { $id = [AgencCronRepair]::Describe($dir, $root); " +
      "if (($id.Attributes -band $link) -ne 0 -or ($id.Attributes -band $folder) -eq 0) { throw \"Not repaired: $root is a junction, a symbolic link or not a directory. Remove it instead.\" }; " +
      "$system = [AgencCronRepair]::FileSystem($dir, $root); " +
      "if ($system -ne 'NTFS') { throw \"Not repaired: $root is on $system, not NTFS. Nothing was changed.\" }; " +
      "$file = [AgencCronRepair]::OpenChild($dir, 'scheduled_tasks.json', $task); " +
      "try { if ($file) { $info = [AgencCronRepair]::Describe($file, $task); " +
        "if (($info.Attributes -band ($link -bor $folder)) -ne 0 -or $info.Links -ne 1) { throw \"Not repaired: $task is a link, a hard-linked file or not a regular file, and nothing was changed. Remove or replace it, then run this again.\" } }; " +
        "[AgencCronRepair]::Protect($dir, (& $descriptor $true), $root); " +
        "[AgencCronRepair]::Prefix = \"Stopped ($root is already private): \"; " +
        "if ($file) { [AgencCronRepair]::Protect($file, (& $descriptor $false), $task); " +
          "$written = [AgencCronRepair]::Describe($file, $task); " +
          "if ($written.Links -ne 1) { throw \"Stopped: another name for $task was added during the repair. $root and that file are already private; remove the other name, then run this again.\" }; " +
          "$same = [AgencCronRepair]::OpenChild($dir, 'scheduled_tasks.json', $task, 0x100080); " +
          "if ($same) { try { $seen = [AgencCronRepair]::Describe($same, $task) } finally { $same.Dispose() } }; " +
          "if (-not $same) { throw \"Stopped: scheduled_tasks.json disappeared during the repair. $root and the original task file are private now; nothing is at that name. Check it, then run this again.\" }; " +
          "if ($seen.Volume -ne $written.Volume -or $seen.IndexHigh -ne $written.IndexHigh -or $seen.IndexLow -ne $written.IndexLow) { throw \"Stopped: scheduled_tasks.json was replaced during the repair. $root and the original task file are private now; the file now at $task was not changed. Check it, then run this again.\" }; " +
          "if ($seen.Links -ne 1) { throw \"Stopped: another name for $task was added during the repair. $root and that file are already private; remove the other name, then run this again.\" } } " +
        "else { $late = [AgencCronRepair]::OpenChild($dir, 'scheduled_tasks.json', $task, 0x100080); " +
          "if ($late) { $late.Dispose(); throw \"Stopped: scheduled_tasks.json appeared during the repair. $root is private now; that file was not changed. Check it, then run this again.\" } } " +
      "} finally { if ($file) { $file.Dispose() } }; " +
      "$again = [AgencCronRepair]::OpenFolder($root); try { $now = [AgencCronRepair]::Describe($again, $root) } finally { $again.Dispose() }; " +
      "if ($now.Volume -ne $id.Volume -or $now.IndexHigh -ne $id.IndexHigh -or $now.IndexLow -ne $id.IndexLow) { throw \"Stopped: $root was replaced during the repair. The directory opened there is private now; whatever is at $root now was not changed. Check it, then run this again.\" } " +
      "} finally { $dir.Dispose() }",
    "\"Repaired $root and its task file; other entries in it keep their ACLs.\" }",
  ].join("; ");
}

/**
 * First-time initialization of a `.agenc` this call just created, run by
 * `runWindowsSecurityScript` with the path and the `lstat` identity in
 * environment variables. It never resolves the path for a write: `.agenc`
 * is opened without following a link, the handle must show a directory on
 * NTFS with the volume serial and file ID of that `lstat` (otherwise the
 * script fails closed before writing), and the descriptor is written
 * through that same handle with `SetKernelObjectSecurity`. Unlike
 * `SetAccessControl`, that write is not propagated to entries someone
 * added to the new directory before it was made private, such as a hard
 * link to an outside file. A read-only probe handle reports the file
 * system and identity first, so a volume that is not NTFS gets the
 * platform message even where the write handle could not be opened.
 * `Add-Type` needs Full Language Mode; without it (Constrained Language
 * Mode, AppLocker, WDAC) the script throws `Add-Type is unavailable (...)`
 * before any handle is opened. There is no path-based fallback: that is the
 * `SetAccessControl` write this replaced, which propagates to children.
 */
const WINDOWS_CREATED_DIRECTORY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$target = $env:AGENC_CRON_DIRECTORY",
  "if ($target.StartsWith('\\\\')) { throw 'network and device paths are unsupported' }",
  // Constrained Language Mode (also what AppLocker and WDAC script rules impose) refuses Add-Type; name it.
  `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw "${WINDOWS_ADD_TYPE_REASON} ($($ExecutionContext.SessionState.LanguageMode))" }`,
  `try { Add-Type -TypeDefinition '${WINDOWS_REPAIR_HELPER}' } catch { throw "${WINDOWS_ADD_TYPE_REASON} ($($_.Exception.GetType().Name))" }`,
  "[AgencCronRepair]::Prefix = ''",
  `$descriptor = ${WINDOWS_PRIVATE_DESCRIPTOR}`,
  "$check = { param($handle) $info = [AgencCronRepair]::Describe($handle, $target); " +
    "if (($info.Attributes -band 0x400) -ne 0) { throw 'reparse points are unsupported' }; " +
    "if (($info.Attributes -band 0x10) -eq 0) { throw 'path role does not match its type' }; " +
    "$system = [AgencCronRepair]::FileSystem($handle, $target); " +
    "if ($system -ne 'NTFS') { throw \"NTFS is required ($system)\" }; " +
    `if ([string]$info.Volume -ne $env:AGENC_CRON_VOLUME -or [string]$info.Index -ne $env:AGENC_CRON_FILE_ID) { throw '${WINDOWS_REPLACED_REASON}' } }`,
  "$probe = [AgencCronRepair]::Probe($target)",
  "try { & $check $probe } finally { $probe.Dispose() }",
  "$dir = [AgencCronRepair]::OpenFolder($target)",
  "try { & $check $dir; [AgencCronRepair]::Protect($dir, (& $descriptor $true), $target) } finally { $dir.Dispose() }",
  "[Console]::Out.Write('OK')",
].join("\n");
const WINDOWS_CREATED_DIRECTORY_SCRIPT_BASE64 = Buffer.from(WINDOWS_CREATED_DIRECTORY_SCRIPT, "utf16le").toString("base64");

/**
 * Publish `scheduled_tasks.json` through one PowerShell process. The directory
 * handle is opened without following a reparse point and must match `identity`.
 * The temporary file is created, written, secured, renamed, and deleted by that
 * handle. `AGENC_CRON_PUBLISH_FAULT` is empty unless a test set it; the script
 * runs the hook only when the fault equals the stage name, and never skips a check.
 */
const WINDOWS_PUBLISH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$target = $env:AGENC_CRON_PUBLISH_DIRECTORY",
  "$name = $env:AGENC_CRON_NAME",
  "$temp = $env:AGENC_CRON_TEMPORARY",
  "if ($target.StartsWith('\\\\')) { throw 'network and device paths are unsupported' }",
  "if ($name -ne 'scheduled_tasks.json') { throw 'invalid publication name' }",
  "if ($temp -notmatch '^scheduled_tasks\\.json\\.[0-9a-fA-F-]{36}\\.tmp$') { throw 'invalid temporary name' }",
  "$memory = New-Object IO.MemoryStream; $chunk = New-Object byte[] 65536; $stdin = [Console]::OpenStandardInput()",
  "for ($n = $stdin.Read($chunk, 0, 65536); $n -gt 0; $n = $stdin.Read($chunk, 0, 65536)) { [void]$memory.Write($chunk, 0, $n) }",
  "$payload = $memory.ToArray()",
  "if ($payload.Length -gt 16777216) { throw 'publication payload exceeds 16777216 bytes' }",
  `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw "${WINDOWS_ADD_TYPE_REASON} ($($ExecutionContext.SessionState.LanguageMode))" }`,
  `try { Add-Type -TypeDefinition '${WINDOWS_PUBLISH_HELPER}' } catch { throw "${WINDOWS_ADD_TYPE_REASON} ($($_.Exception.GetType().Name))" }`,
  "[AgencCronRepair]::Prefix = ''",
  `$descriptor = ${WINDOWS_PRIVATE_DESCRIPTOR}`,
  "$R = 'Cron temporary publication file was replaced or linked'",
  "$M = 'publication directory changed before acknowledgement'",
  "function Invoke-PublishFault([string]$stage) { if ($env:AGENC_CRON_PUBLISH_FAULT -ne $stage) { return }; $hook = $env:AGENC_CRON_PUBLISH_HOOK; if ([string]::IsNullOrEmpty($hook)) { return }; if ($hook -notmatch '^[A-Za-z]:\\\\[^|&;<>]+\\.ps1$') { throw 'publication fault hook is not a local script path' }; & $hook $stage $env:AGENC_CRON_PUBLISH_DIRECTORY $env:AGENC_CRON_TEMPORARY $env:AGENC_CRON_NAME }",
  "function Test-File([object]$i) { if (($i.Attributes -band 0x410) -ne 0 -or $i.Links -ne 1) { throw $R } }",
  "function Assert-Dir { $p = [AgencCronRepair]::Probe($target); try { $n = [AgencCronRepair]::Describe($p, $target); if (($n.Attributes -band 0x400) -ne 0 -or ($n.Attributes -band 0x10) -eq 0 -or [string]$n.Volume -ne [string]$id.Volume -or [string]$n.Index -ne [string]$id.Index) { throw $M } } finally { $p.Dispose() } }",
  "$full = $target + '\\' + $name; $tempPath = $target + '\\' + $temp; $bak = $temp + '.bak'",
  "$dir = [AgencCronRepair]::OpenPublishFolder($target)",
  "try {",
  "  $id = [AgencCronRepair]::Describe($dir, $target)",
  "  if (($id.Attributes -band 0x400) -ne 0) { throw 'reparse points are unsupported' }",
  "  if (($id.Attributes -band 0x10) -eq 0) { throw 'path role does not match its type' }",
  "  $system = [AgencCronRepair]::FileSystem($dir, $target)",
  "  if ($system -ne 'NTFS') { throw \"NTFS is required ($system)\" }",
  `  if ([string]$id.Volume -ne $env:AGENC_CRON_VOLUME -or [string]$id.Index -ne $env:AGENC_CRON_FILE_ID) { throw '${WINDOWS_REPLACED_REASON}' }`,
  "  $stageCreate = 'before-temp-create'; if ($stageCreate -ne 'before-temp-create') { throw 'publication stage changed' }; Invoke-PublishFault 'before-temp-create'",
  "  $created = [AgencCronRepair]::CreateNewChild($dir, $temp)",
  "  $renamed = $false; $existed = $false; $prev = $null",
  "  try {",
  "    Test-File ([AgencCronRepair]::Describe($created, $tempPath))",
  "    $stageSecurity = 'before-temp-security'; if ($stageSecurity -ne 'before-temp-security') { throw 'publication stage changed' }; Invoke-PublishFault 'before-temp-security'",
  "    Test-File ([AgencCronRepair]::Describe($created, $tempPath))",
  "    [AgencCronRepair]::Protect($created, (& $descriptor $false), $tempPath)",
  "    [AgencCronRepair]::WriteAll($created, $payload)",
  "    $born = [AgencCronRepair]::Describe($created, $tempPath); Test-File $born",
  "    if (([int64]$born.SizeLow + ([int64]$born.SizeHigh * [int64]4294967296)) -ne [int64]$payload.LongLength) { throw 'publication write did not match the task bytes' }",
  "    $stageRename = 'before-rename'; if ($stageRename -ne 'before-rename') { throw 'publication stage changed' }; Invoke-PublishFault 'before-rename'",
  "    if (([AgencCronRepair]::Describe($created, $tempPath)).Links -ne 1) { throw $R }",
  "    Assert-Dir",
  "    $seen = [AgencCronRepair]::OpenChild($dir, $name, $full, 0x120089); $existed = [bool]$seen",
  "    if ($seen) { try { $cur = [AgencCronRepair]::Describe($seen, $full); if (($cur.Attributes -band 0x410) -ne 0) { throw 'publication target is a link or not a file' }; $prev = [AgencCronRepair]::ReadRecord($seen, $cur) } finally { $seen.Dispose() } }",
  "    [AgencCronRepair]::RenameWithin($created, $dir, $name, $true)",
  "    $renamed = $true",
  "    $stageAfter = 'after-rename'; if ($stageAfter -ne 'after-rename') { throw 'publication stage changed' }; Invoke-PublishFault 'after-rename'",
  "    [AgencCronRepair]::FlushFolder($dir)",
  "    $stagePublished = 'before-published-check'; if ($stagePublished -ne 'before-published-check') { throw 'publication stage changed' }; Invoke-PublishFault 'before-published-check'",
  "    $check = [AgencCronRepair]::OpenChild($dir, $name, $full, 0x100080)",
  "    try { if (-not $check) { throw $M }; $seenNow = [AgencCronRepair]::Describe($check, $full); $mine = [AgencCronRepair]::Describe($created, $full); if ($seenNow.Volume -ne $mine.Volume -or $seenNow.IndexHigh -ne $mine.IndexHigh -or $seenNow.IndexLow -ne $mine.IndexLow -or $seenNow.Links -ne 1 -or ($seenNow.Attributes -band 0x410) -ne 0) { throw $R } } finally { if ($check) { $check.Dispose() } }",
  "    Assert-Dir",
  "  } catch { $failure = $_; $mark = ' [previous-record-untouched]'; if ($renamed) { if ($existed) { $mark = ' [previous-record-not-restored]'; try { if ($env:AGENC_CRON_PUBLISH_ROLLBACK -eq '1') { throw 'injected rollback failure' }; $restore = [AgencCronRepair]::CreateNewChild($dir, $bak); try { [AgencCronRepair]::Protect($restore, (& $descriptor $false), $tempPath); [AgencCronRepair]::WriteAll($restore, $prev); [AgencCronRepair]::RenameWithin($restore, $dir, $name, $true); $mark = ' [previous-record-restored]' } finally { $restore.Dispose() } } catch {} } else { $mark = ' [new-record-in-place]' } } else { try { [AgencCronRepair]::DeleteWhenClosed($created) } catch {} }; throw (New-Object System.InvalidOperationException(($failure.Exception.Message + $mark), $failure.Exception)) }",
  "  finally { $created.Dispose() }",
  "} finally { $dir.Dispose() }",
  "[Console]::Out.Write('OK')",
].join("\n");
const WINDOWS_PUBLISH_BODY_BASE64 = Buffer.from(WINDOWS_PUBLISH_SCRIPT, "utf8").toString("base64");
// The body is larger than the CreateProcess command-line limit, so the encoded
// command is only this bootstrap. The body is a variable this process sets; it
// is not read from the caller's environment.
const WINDOWS_PUBLISH_BOOTSTRAP = [
  "$ErrorActionPreference = 'Stop'",
  `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw "${WINDOWS_ADD_TYPE_REASON} ($($ExecutionContext.SessionState.LanguageMode))" }`,
  "Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGENC_CRON_PUBLISH_BODY)))",
].join("\n");
const WINDOWS_PUBLISH_BOOTSTRAP_BASE64 = Buffer.from(WINDOWS_PUBLISH_BOOTSTRAP, "utf16le").toString("base64");

const WINDOWS_PUBLISH_HOOK_PATH = /^[A-Za-z]:\\[^|&;<>\r\n"]+\.ps1$/u;

/**
 * Publish the task file through the handle-bound script. A non-empty
 * `AGENC_CRON_PUBLISH_FAULT` is the only way `AGENC_CRON_PUBLISH_HOOK` is
 * forwarded, and only when that hook is one local `.ps1` path. The gated
 * `AGENC_CRON_PUBLISH_ROLLBACK` test knob (which forces the recovery replace to
 * fail) rides the same fault switch. Production leaves all three empty. The hook
 * does not skip identity, type, link, or NTFS checks.
 */
export async function publishWindowsCronFile(
  directory: string,
  identity: BigIntStats,
  data: string,
  inspectRecord: () => Promise<Buffer | undefined>,
): Promise<void> {
  if (Buffer.byteLength(data, "utf8") > MAX_CRON_FILE_BYTES) {
    throw new Error("Cron task file exceeds its byte limit");
  }
  const fault = process.env.AGENC_CRON_PUBLISH_FAULT ?? "";
  const hookRaw = process.env.AGENC_CRON_PUBLISH_HOOK ?? "";
  const hook = fault !== "" && WINDOWS_PUBLISH_HOOK_PATH.test(hookRaw) ? hookRaw : "";
  try {
    runWindowsSecurityScript(directory, WINDOWS_PUBLISH_BOOTSTRAP_BASE64, {
      AGENC_CRON_PUBLISH_DIRECTORY: directory,
      AGENC_CRON_PUBLISH_BODY: WINDOWS_PUBLISH_BODY_BASE64,
      AGENC_CRON_VOLUME: identity.dev.toString(),
      AGENC_CRON_FILE_ID: identity.ino.toString(),
      AGENC_CRON_NAME: CRON_STORAGE_NAME,
      AGENC_CRON_TEMPORARY: `${CRON_STORAGE_NAME}.${randomUUID()}.tmp`,
      AGENC_CRON_PUBLISH_FAULT: fault,
      AGENC_CRON_PUBLISH_HOOK: hook,
      AGENC_CRON_PUBLISH_ROLLBACK: fault !== "" ? (process.env.AGENC_CRON_PUBLISH_ROLLBACK ?? "") : "",
    }, tmpdir(), Buffer.from(data, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.name === "WindowsPrivatePathSecurityError") {
      // A killed child cannot append a caught-failure marker. Read through the
      // caller's verified storage boundary; matching bytes confirm the intended
      // record is present, not that this attempt was acknowledged. Never retry
      // the write here, or infer that a different record is the previous one.
      if (windowsPublicationOutcome(error) === undefined && classifyWindowsCronFailure(error).kind === "unknown") {
        let record: "new" | "different" | "absent" | "unknown" = "unknown";
        try {
          const current = await inspectRecord();
          record = current === undefined ? "absent" : current.equals(Buffer.from(data, "utf8")) ? "new" : "different";
        } catch { /* A failed readback cannot establish which record is in place. */ }
        const outcome = record === "new"
          ? "The new task file is in place, but the write was not acknowledged. Check the scheduled tasks before " +
            "retrying; retrying an append can add the task twice."
          : record === "different"
          ? "The task file on disk does not match the requested new record. Check the scheduled tasks before retrying."
          : record === "absent"
          ? "No task file was found during readback. Check the scheduled tasks before retrying."
          : "The task file left on disk could not be verified. Check the scheduled tasks before retrying.";
        throw new CronStorageAclError(
          `Durable cron storage could not acknowledge the task file in ${directory}. ${outcome}`,
          directory, { cause: error },
        );
      }
      throw windowsCronAclError(directory, error, "record");
    }
    throw error;
  }
}

/** Make a `.agenc` this call created private, through a handle bound to `created` (its `lstat`). */
function initializeCreatedWindowsDirectory(path: string, created: BigIntStats): void {
  runWindowsSecurityScript(path, WINDOWS_CREATED_DIRECTORY_SCRIPT_BASE64, {
    AGENC_CRON_DIRECTORY: path,
    AGENC_CRON_VOLUME: created.dev.toString(),
    AGENC_CRON_FILE_ID: created.ino.toString(),
  }, tmpdir());
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
    const format = windowsDriveFormat(cause);
    const where = failure.reason !== "NTFS is required"
      ? `${directory} is a network or device path`
      : format === undefined
        ? `${directory} is on a volume that is not NTFS`
        : `${directory} is on a volume formatted as ${format}`;
    return fail(
      `Durable cron storage on Windows requires a local NTFS volume, and ${where}. ` +
        "This is a platform limitation that no permission change can fix; its permissions were left unchanged. " +
        "Move the project to a local NTFS volume, or schedule the task with durable:false.",
    );
  }
  if (failure.kind === "addtype") {
    const detail = windowsAddTypeDetail(cause);
    const why = detail === undefined ? "" : /Language$/u.test(detail)
      ? ` (PowerShell runs in ${detail} mode)` : ` (Add-Type failed with ${detail})`;
    return fail(
      `Durable cron storage on Windows could not make ${directory} private: that step loads a small C# helper ` +
        `with PowerShell Add-Type, and Add-Type is not available here${why}. Constrained Language Mode, and AppLocker ` +
        "or WDAC (Windows Defender Application Control) policies, block it. No ACL was written, and the directory was " +
        "left unchanged. Allow Add-Type for this account, or remove that directory and schedule the task with durable:false.",
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
  if (failure.kind === "replaced") {
    return fail(
      `${OWNERSHIP_ERROR}: ${directory} was replaced after it was created and before its ACL was set, ` +
        "and no ACL was written. Check what is at that path, then retry.",
    );
  }
  if (failure.kind === "publication") {
    const code = windowsPublicationCode(cause);
    const outcome = windowsPublicationOutcome(cause);
    const tail = outcome === "new-record-in-place"
      ? "Nothing outside the verified directory was written. No earlier task file existed, so the new record is in place " +
        "but the write was not acknowledged; check it, then retry."
      : outcome === "previous-record-not-restored"
      ? "Nothing outside the verified directory was written, but the previous task file could not be restored after the " +
        "failure, so the record now in place is the new one; check it, then retry."
      : "Nothing outside the verified directory was written, and the previous task file was left in place " +
        "when publication could not be acknowledged.";
    return fail(
      `Durable cron storage did not publish the task file in ${directory}: ${failure.reason}${code === undefined ? "" : ` (${code})`}. ${tail}`,
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
  ensureWindowsPrivateDirectory(directory, directoryInfo, opened.created);
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
        return assertRealDirectory(directory, directoryInfo);
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
    // No ACL repair applies to a link: it is to be removed or replaced.
    throw new CronStorageAclError(
      `${OWNERSHIP_ERROR}: ${directory} is a symbolic link, a junction or not a directory, and it was left ` +
        "unchanged. Remove it, or replace it with a regular directory, then retry.",
      directory,
    );
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

function ensureWindowsPrivateDirectory(path: string, info: BigIntStats, created: boolean): void {
  if (created) {
    // A failed first initialization leaves `.agenc` behind. Later calls see
    // it as existing and only validate, so this error names the repair.
    // The ACL is written through a handle bound to `info`, never by path
    // (`SetAccessControl` would re-resolve the path and propagate to entries
    // added since `mkdir`).
    try {
      initializeCreatedWindowsDirectory(path, info);
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
