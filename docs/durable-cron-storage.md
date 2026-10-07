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
After that directory check passes, an unsafe task file is replaced atomically
with a newly created private file, and a read of an unsafe task file is
rejected. The project workspace keeps its existing ACL.

On Windows this means a normal project `.agenc` is rejected until it is
repaired. `agenc init`, skills, MCP config, worktrees, imagine output, agent
memory, and Explorer or `mkdir` all create `.agenc` with the ACL inherited
from the project folder, and durable cron does not change it. When the ACL
check names an ACL problem, the error names the directory and prints this
PowerShell script for it (Windows PowerShell 5.1 or PowerShell 7; shown here
for `C:\src\my project\.agenc`):

```powershell
& { $ErrorActionPreference = 'Stop'; $root = 'C:\src\my project\.agenc'; $link = [IO.FileAttributes]::ReparsePoint; $folder = [IO.FileAttributes]::Directory; $a = [IO.File]::GetAttributes($root); if (($a -band $link) -ne 0 -or ($a -band $folder) -eq 0) { throw "Not repaired: $root is a junction, a symbolic link or not a directory. Remove it instead." }; Add-Type -Namespace AgencCronRepair -Name Native -MemberDefinition '[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetFileSecurityW(string path, int info, byte[] descriptor);'; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; $private = { param($path, $isFolder) if ($isFolder) { $acl = New-Object Security.AccessControl.DirectorySecurity; $inherit = 'ContainerInherit, ObjectInherit' } else { $acl = New-Object Security.AccessControl.FileSecurity; $inherit = 'None' }; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow'))); if (-not [AgencCronRepair.Native]::SetFileSecurityW($path, 0x80000005, $acl.GetSecurityDescriptorBinaryForm())) { $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); $why = (New-Object ComponentModel.Win32Exception($code)).Message; throw (New-Object ComponentModel.Win32Exception($code, "Not repaired: $path ($why)")) } }; & $private $root $true; $todo = New-Object Collections.Stack; $todo.Push($root); $skipped = 0; while ($todo.Count -gt 0) { foreach ($path in [IO.Directory]::GetFileSystemEntries($todo.Pop())) { $a = [IO.File]::GetAttributes($path); if (($a -band $link) -ne 0) { Write-Warning "Skipped link: $path"; $skipped++ } elseif (($a -band $folder) -ne 0) { & $private $path $true; $todo.Push($path) } elseif ((Get-Item -LiteralPath $path -Force).LinkType -eq 'HardLink') { Write-Warning "Skipped hard-linked file: $path"; $skipped++ } else { & $private $path $false } } }; "Repaired $root ($skipped links skipped)" }
```

The script refuses a `.agenc` that is itself a junction or symbolic link. It
then walks `.agenc` with an explicit stack and makes each directory private
before listing it, so no one else can add or swap an entry during the walk.
Junctions and symbolic links inside it are skipped and never entered, and
files with more than one hard link are skipped, so nothing outside `.agenc`
changes; each skipped entry is printed as a warning. Every other directory
and file gets the current user as owner and a protected DACL with one allow
FullControl entry for that user (inherited by new entries in directories),
the same descriptor durable cron writes when it creates `.agenc`. The script
stops at the first error. It writes each descriptor with `SetFileSecurityW`
because `Set-Acl`, .NET `SetAccessControl` and `icacls` also rewrite the
inherited entries of every child, which changes the outside file behind a
hard link; `icacls /T` also follows junctions. It loads that function with
`Add-Type`, so it does not run in Constrained Language Mode. The project
folder's ACL is not written. Other accounts, including sandbox groups, lose access to
`.agenc`.

The same script is offered when a newly created `.agenc` could not be made
private (removing that directory also works) and when `.agenc` or the task
file cannot be inspected (`EACCES`/`EPERM`; run it elevated if access is
denied). A task file that is a symbolic link, a junction, hard-linked, or not
a regular file gets no ACL repair: remove it or replace it with a regular
file. Durable cron on Windows requires a local NTFS volume; a ReFS Dev Drive
or network path is rejected without a repair. Session startup, the gateway
delivery scan and the in-session scheduler report a rejected `.agenc` only
when the task file exists or its existence cannot be checked.
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
