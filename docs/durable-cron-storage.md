# Durable cron storage

Durable cron storage on macOS, and on Linux without traversable directory
descriptors (`/proc/self/fd`), fails closed with `descriptor-confined I/O is
unsupported`. Durable creation, mutation, and gateway delivery are unavailable
there. Windows persists scheduled tasks through the same private-path policy
as workflow handoff storage: `.agenc` and `scheduled_tasks.json` must pass the
current-user ACL check, identity comes from a stat of that verified path, and
publication uses a path temporary whose inode is checked again after the
write. This is a compatibility change. Session-only in-memory jobs do not
require durable storage. There is no pathname fallback on macOS or Linux:
checks before and after an ordinary pathname write cannot undo an overwrite
redirected during the write.

The OS account home must already exist on a local filesystem accepted by the
SQLite lock security checks, even when `AGENC_HOME` is elsewhere. Unavailable
or unsafe cron storage does not prevent unrelated commands from using a valid
configured AgenC home. No code in this change creates or changes permissions
on the OS account home itself.

If OS account lookup fails, ordinary sandbox policies retain any previously
verified cron reservations. A process that first builds a policy without a
trusted OS identity keeps durable cron disabled until restart, even if account
lookup later recovers. `HOME` and `AGENC_HOME` never supply the missing authority.
The separate existing POSIX credential-account check still requires OS identity
when creating a new home context or broker; this change does not relax that check.

Unsafe or unsupported storage is reported by CronList as an error, by session
startup and active schedulers as `cron_storage_unavailable` warnings, and by
the gateway as a delivery-state diagnostic including the concrete cause.
Only missing or malformed task records retain the empty-list behavior. Failed
durable loads admit only the owning conversation's in-memory jobs; they do not
dispatch durable jobs. Later rescheduling can retry after storage is repaired.
Warnings from superseded scheduler scans are discarded. Session startup stays
silent on a platform without descriptor-confined I/O when the workspace has no
`.agenc/scheduled_tasks.json`: there is nothing to restore. A record that exists
there is still reported.

Stop **all older AgenC scheduler and gateway processes using a workspace before
upgrading its writers**, and do the same before rolling back. Old versions use
workspace-local SQLite locks. New versions use a different namespace and do not
contend with old versions; mixed-version operation is unsupported. The cron
JSON format is unchanged. Old project lock files are left untouched and are no
longer opened by the new scheduler.

The durable task and delivery-outbox records remain in
`<workspace>/.agenc/scheduled_tasks.json`. On macOS and Linux, reads and atomic
replacement retain opened workspace and `.agenc` directory descriptors through
publication, directory sync, and cleanup. On Windows, those directory
descriptors do not exist, so the same steps retain the verified `.agenc` path,
its current-user ACL, and the published file inode; directory sync that the
platform refuses is not treated as a lost write. A linked `.agenc` directory
or a symlink/hardlink task file is refused. Existing current-user-owned 755
directories and 644 files remain supported on macOS and Linux when other users
cannot write them. New task files use 600. On Windows, `.agenc` receives a
current-user-only ACL only when this operation creates that directory. An
existing `.agenc` is validated and left unchanged; an unsafe ACL is rejected.

That first ACL is written through a handle, not by path. Windows ignores the
`mkdir` mode, so until the ACL is written the new `.agenc` carries the
project folder's inherited ACL, and anyone that ACL allows could add a hard
link to an outside file or swap in another directory. Durable cron therefore
opens the new `.agenc` without following a link
(`FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`), requires that
handle to show a directory on NTFS with the volume serial number and file ID
of the `lstat` taken right after `mkdir` (otherwise it fails closed and
writes nothing), and writes the owner and protected ACL through that handle
with `SetKernelObjectSecurity`. That write does not propagate to entries
already in the directory, so a planted hard link keeps the ACL of the file
it points to. The path is then verified read-only. This uses the same C#
helper as the repair script below. Windows PowerShell 5.1 compiles that
helper (`Add-Type`) in the user's `TEMP` directory. What remains: a
directory swapped in between `mkdir` and that `lstat` is the one made private
(nothing outside it changes), and entries added before the ACL is written
stay in `.agenc` with their own ACLs; a task file among them must still be a
regular file with one link, or it is refused.

Loading that helper needs PowerShell Full Language Mode. Under Constrained
Language Mode, or an AppLocker or WDAC (Windows Defender Application Control)
policy that blocks `Add-Type`, creating `.agenc` fails closed: the error names
`Add-Type` and those policies, no ACL is written, and the new directory is
left unchanged. There is no fallback to `SetAccessControl`, which would bring
back the propagation described above. On such a machine, allow `Add-Type` for
the account or schedule tasks with `durable:false`.

After that directory check passes, every task update reads the task file
first. A task file that is a link, hard-linked, not a regular file, or not
private to the current user is rejected on read and on update and left
unchanged; durable cron does not rewrite it. Only a private task file (or a
missing one) is replaced, atomically, with a new private file. The project
workspace keeps its existing ACL.

On Windows this means a normal project `.agenc` is rejected until it is
repaired. `agenc init`, skills, MCP config, worktrees, imagine output, agent
memory, and Explorer or `mkdir` all create `.agenc` with the ACL inherited
from the project folder, and durable cron does not change it. When the ACL
check names an ACL problem, the error names the directory and prints this
PowerShell script for it (Windows PowerShell 5.1 or PowerShell 7; shown here
for `C:\src\my project\.agenc`):

```powershell
& { $ErrorActionPreference = 'Stop'; $root = 'C:\src\my project\.agenc'; if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw "Not repaired: this PowerShell runs in $($ExecutionContext.SessionState.LanguageMode) mode and the repair needs Add-Type (Full Language Mode). Nothing was changed." }; Add-Type -TypeDefinition 'using System; using System.ComponentModel; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles; public static class AgencCronRepair { [StructLayout(LayoutKind.Sequential)] public struct Info { public uint Attributes, Created1, Created2, Accessed1, Accessed2, Written1, Written2, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; public ulong Index { get { return ((ulong)IndexHigh << 32) | IndexLow; } } } [StructLayout(LayoutKind.Sequential)] struct Text { public ushort Length, MaximumLength; public IntPtr Buffer; } [StructLayout(LayoutKind.Sequential)] struct Target { public int Length; public IntPtr Root, Name; public uint Flags; public IntPtr Descriptor, Quality; } [StructLayout(LayoutKind.Sequential)] struct Result { public IntPtr Status, Information; } [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template); [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info); [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder name, int nameSize, out uint serial, out uint length, out uint flags, StringBuilder system, int systemSize); [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint information, byte[] descriptor); [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref Target target, out Result result, IntPtr size, uint attributes, uint share, uint disposition, uint options, IntPtr extra, uint extraLength); [DllImport("ntdll.dll")] static extern int RtlNtStatusToDosError(int status); public static string Prefix = "Not repaired: "; static Exception Fail(int code, string path) { return new Win32Exception(code, Prefix + path + " (" + new Win32Exception(code).Message + ")"); } static SafeFileHandle Open(string path, uint access) { SafeFileHandle handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero); if (handle.IsInvalid) throw Fail(Marshal.GetLastWin32Error(), path); return handle; } public static SafeFileHandle OpenFolder(string path) { return Open(path, 0x1E00A0); } public static SafeFileHandle Probe(string path) { return Open(path, 0x120080); } public static SafeFileHandle OpenChild(SafeFileHandle folder, string name, string path) { return OpenChild(folder, name, path, 0x1E0080); } public static SafeFileHandle OpenChild(SafeFileHandle folder, string name, string path, uint access) { Text text = new Text(); text.Length = (ushort)(name.Length * 2); text.MaximumLength = text.Length; text.Buffer = Marshal.StringToHGlobalUni(name); IntPtr textPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Text))); try { Marshal.StructureToPtr(text, textPointer, false); Target target = new Target(); target.Length = Marshal.SizeOf(typeof(Target)); target.Root = folder.DangerousGetHandle(); target.Name = textPointer; target.Flags = 0x40; SafeFileHandle handle; Result result; int status = NtCreateFile(out handle, access, ref target, out result, IntPtr.Zero, 0, 7, 1, 0x200020, IntPtr.Zero, 0); if (status == unchecked((int)0xC0000034)) return null; if (status < 0) throw Fail(RtlNtStatusToDosError(status), path); return handle; } finally { Marshal.FreeHGlobal(textPointer); Marshal.FreeHGlobal(text.Buffer); } } public static Info Describe(SafeFileHandle handle, string path) { Info info; if (!GetFileInformationByHandle(handle, out info)) throw Fail(Marshal.GetLastWin32Error(), path); return info; } public static string FileSystem(SafeFileHandle handle, string path) { uint serial, length, flags; StringBuilder system = new StringBuilder(261); if (!GetVolumeInformationByHandleW(handle, null, 0, out serial, out length, out flags, system, 261)) throw Fail(Marshal.GetLastWin32Error(), path); return system.ToString(); } public static void Protect(SafeFileHandle handle, byte[] descriptor, string path) { if (!SetKernelObjectSecurity(handle, 0x80000005, descriptor)) throw Fail(Marshal.GetLastWin32Error(), path); } }'; [AgencCronRepair]::Prefix = 'Not repaired: '; $descriptor = { param($isFolder) $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; if ($isFolder) { $acl = New-Object Security.AccessControl.DirectorySecurity; $inherit = 'ContainerInherit, ObjectInherit' } else { $acl = New-Object Security.AccessControl.FileSecurity; $inherit = 'None' }; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow'))); ,$acl.GetSecurityDescriptorBinaryForm() }; $link = 0x400; $folder = 0x10; $task = $root + '\scheduled_tasks.json'; $dir = [AgencCronRepair]::OpenFolder($root); try { $id = [AgencCronRepair]::Describe($dir, $root); if (($id.Attributes -band $link) -ne 0 -or ($id.Attributes -band $folder) -eq 0) { throw "Not repaired: $root is a junction, a symbolic link or not a directory. Remove it instead." }; $system = [AgencCronRepair]::FileSystem($dir, $root); if ($system -ne 'NTFS') { throw "Not repaired: $root is on $system, not NTFS. Nothing was changed." }; $file = [AgencCronRepair]::OpenChild($dir, 'scheduled_tasks.json', $task); try { if ($file) { $info = [AgencCronRepair]::Describe($file, $task); if (($info.Attributes -band ($link -bor $folder)) -ne 0 -or $info.Links -ne 1) { throw "Not repaired: $task is a link, a hard-linked file or not a regular file, and nothing was changed. Remove or replace it, then run this again." } }; [AgencCronRepair]::Protect($dir, (& $descriptor $true), $root); [AgencCronRepair]::Prefix = "Stopped ($root is already private): "; if ($file) { [AgencCronRepair]::Protect($file, (& $descriptor $false), $task); $written = [AgencCronRepair]::Describe($file, $task); if ($written.Links -ne 1) { throw "Stopped: another name for $task was added during the repair. $root and that file are already private; remove the other name, then run this again." }; $same = [AgencCronRepair]::OpenChild($dir, 'scheduled_tasks.json', $task, 0x100080); if ($same) { try { $seen = [AgencCronRepair]::Describe($same, $task) } finally { $same.Dispose() } }; if (-not $same -or $seen.Volume -ne $written.Volume -or $seen.IndexHigh -ne $written.IndexHigh -or $seen.IndexLow -ne $written.IndexLow -or $seen.Links -ne 1) { throw "Stopped: scheduled_tasks.json was replaced during the repair. $root and the original task file are private now; the file now at $task was not changed. Check it, then run this again." } } else { $late = [AgencCronRepair]::OpenChild($dir, 'scheduled_tasks.json', $task, 0x100080); if ($late) { $late.Dispose(); throw "Stopped: scheduled_tasks.json appeared during the repair. $root is private now; that file was not changed. Check it, then run this again." } } } finally { if ($file) { $file.Dispose() } }; $again = [AgencCronRepair]::OpenFolder($root); try { $now = [AgencCronRepair]::Describe($again, $root) } finally { $again.Dispose() }; if ($now.Volume -ne $id.Volume -or $now.IndexHigh -ne $id.IndexHigh -or $now.IndexLow -ne $id.IndexLow) { throw "Stopped: $root was replaced during the repair. The directory opened there is private now; whatever is at $root now was not changed. Check it, then run this again." } } finally { $dir.Dispose() }; "Repaired $root and its task file; other entries in it keep their ACLs." }
```

The repair is the minimum durable cron needs. It changes at most two
objects: the `.agenc` directory itself and, if it exists, its
`scheduled_tasks.json`. Each gets the current user as owner and a protected
ACL with one full-control entry for that user (inherited by new entries in
the directory, so the files cron creates later are private too). That is the
same descriptor durable cron writes when it creates `.agenc`. Nothing is
walked: `skills/`, `worktrees/`, `imagine/`, `agent-memory/`, `mcp/`,
`config.toml` and every other existing entry in `.agenc` keep their current
ACLs. The project folder's ACL is not written.

**Task contents are kept.** The repair changes ACLs only. It keeps the bytes
of an existing `scheduled_tasks.json`, and durable cron loads those tasks once
the file is private. If you did not write the tasks in that file yourself (for
example, it appeared in a new `.agenc` before durable cron made the directory
private), inspect it, or delete it, before you run the repair.

**Who loses access.** The repair replaces the ACL of `.agenc` and the task
file, so every other account loses access to them: SYSTEM, Administrators,
Users, Authenticated Users, Everyone, sandbox or AppContainer groups such as
`CodexSandboxUsers`, and any other explicit entries. For example, backup,
antivirus or indexing software that runs as SYSTEM can no longer list
`.agenc` or read the task file, and a sandboxed agent that relied on a sandbox
group can no longer open `.agenc`. Entries inside `.agenc` keep their own
ACLs, but other accounts can no longer list `.agenc` to find them.

**Containment.** The script does not rely on skipping links. It opens `.agenc`
once without following a link (`FILE_FLAG_OPEN_REPARSE_POINT`), reads its type,
reparse attribute and file ID from that handle, and refuses a junction,
symbolic link or non-directory, and a volume that is not NTFS (read from the
same handle). The task file is opened relative to the `.agenc` handle, also
without following a link, and must be a regular file with one link. These
checks run before anything is written: a refused or unopenable task file stops
the script and leaves `.agenc` unchanged. Then both descriptors are written
through those handles (`SetKernelObjectSecurity`), so a path swapped after the
opens cannot redirect a write. After the task file's write, its link count is
read again, and `scheduled_tasks.json` is opened again relative to the
`.agenc` handle (attributes only) and must still be the same file (volume
serial number and file ID) with one link. A rename keeps the count at one, so
this is what catches another file put at that name; the script then stops
with "Stopped: scheduled_tasks.json was replaced during the repair" instead
of `Repaired`. If there was no task file, one that appears during the repair
also stops it. At the end `.agenc` is reopened and must still have the same
volume serial number and file ID. Every message after the first write starts
with "Stopped" and says what is already private; "Not repaired" means nothing
was changed.

The task file is not opened with share mode 0. Windows applies share modes
only to opens that request read, write or delete access, and `CreateHardLink`
does not: on Windows 11 it added names to a task file held open with share
mode 0, also with `DELETE` or `FILE_READ_DATA` access. Share mode 0 also made
the open fail with a sharing violation while another process, such as a
running AgenC, had the file open. The link count read after the write covers
that window instead; once the file is private, only the current user can open
it to add a name.
`Set-Acl`, .NET `SetAccessControl` and `icacls` are not used: they also
rewrite the inherited entries of every existing child, which on Windows 11
changed an outside file hard-linked into `.agenc`, and `icacls /T` follows
junctions. The script loads its helper with `Add-Type`, so it does not run in
Constrained Language Mode; there it stops before anything is written and says
so. It stops at the first error.

**Remaining race.** Whatever real directory is at the `.agenc` path when the
script opens it is the one made private. Someone who can rename entries in
the project folder could put their own directory there just before the
repair; that directory is then made private to the current user (they lose
access to it, and nothing outside it changes). A swap after the open is
reported by the final identity check. Windows checks access when a handle is
opened, so an account that opened `.agenc` or the task file before the repair
keeps that handle's access until it closes it; a rename through such a handle
after the script's last check is not reported, and the next durable cron read
checks the task file again.

The same script is offered when a newly created `.agenc` could not be made
private (removing that directory also works) and when `.agenc` or the task
file cannot be inspected (`EACCES`/`EPERM`; run it elevated if access is
denied). It is not offered for anything else:

- A `.agenc` that is itself a symbolic link, a junction or not a directory:
  remove it or replace it with a regular directory.
- A task file that is a symbolic link, a junction, hard-linked, or not a
  regular file: remove it or replace it with a regular file.
- A volume that is not NTFS (the message names its file system, for example
  ReFS on a Dev Drive, FAT32 or exFAT) or a network or device path: this is a
  platform limitation. Move the project to a local NTFS volume, or schedule
  the task with `durable:false`.
- A newly created `.agenc` that was replaced before its ACL was set: nothing
  was written; check what is at that path, then retry.
- A newly created `.agenc` that could not be made private because `Add-Type`
  is unavailable (Constrained Language Mode, AppLocker or WDAC): nothing was
  written; allow `Add-Type` or schedule the task with `durable:false`.

Session startup, the gateway delivery scan and the in-session scheduler
report a rejected `.agenc` only when the task file exists or its existence
cannot be checked.
Concurrent edits may cause a transaction to fail; failure after publication
does not imply that the original task file is unchanged.

All task-transaction and 16 delivery-execution SQLite locks reside in
`<OS account home>/.agenc-cron-locks-v1/<workspace identity>/`. The OS account
home comes from the operating system, independent of `HOME`, `AGENC_HOME`,
session settings, and tool arguments. The workspace identity hashes its device
and inode so canonical aliases, renames, independent AgenC homes, and separate
processes coordinate on the same locks. Lock files retain the shared SQLite
implementation's ownership, single-link, ACL, local-filesystem, sentinel, and
crash-release checks.

The lock namespace is reserved from sandboxed model writes and ancestor
replacement, including additional filesystem grants and broker overrides.
Durable cron refuses a workspace that contains or is contained by this lock
namespace, and refuses redirected lock directories or linked lock files.
Explicit unsandboxed execution remains operator trust. These protections do
not claim resistance to a separate malicious native process running as the
same OS user or to an administrator changing the trusted OS-home namespace.

Lock directories persist to preserve their cross-process inode identity; they
must not be removed while any current scheduler or gateway uses the workspace.
