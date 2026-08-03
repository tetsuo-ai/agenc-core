/** Owner-only Windows path initialization and verification for workflow bytes. */

import { execFileSync } from "node:child_process";
import { win32 } from "node:path";

const WINDOWS_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;
const WINDOWS_SECURITY_TIMEOUT_MS = 30_000;
const WINDOWS_SECURITY_MAX_OUTPUT_BYTES = 1_048_576;
const WINDOWS_PRIVATE_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($env:AGENC_WORKFLOW_PRIVATE_PATH)
$role = $env:AGENC_WORKFLOW_PRIVATE_ROLE
$initialize = $env:AGENC_WORKFLOW_PRIVATE_INITIALIZE -eq '1'
if (@('directory', 'file') -notcontains $role) { throw 'invalid role' }
if ($target.StartsWith('\\') -or $target.StartsWith('\\?\') -or $target.StartsWith('\\.\')) {
  throw 'network and device paths are unsupported'
}
$item = Get-Item -LiteralPath $target -Force
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'reparse points are unsupported'
}
$drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($target))
if ($drive.DriveFormat -ne 'NTFS') { throw 'NTFS is required' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($initialize) {
  if ($role -eq 'directory') {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $acl
}
$verified = Get-Acl -LiteralPath $target
if (-not $verified.AreAccessRulesProtected) { throw 'inherited ACL is unsupported' }
if ($verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
  throw 'path owner is not the current user'
}
$rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$hasFullControl = $false
foreach ($rule in $rules) {
  if ($rule.IsInherited) { throw 'inherited ACE is unsupported' }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
    throw 'deny ACE is unsupported'
  }
  if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'foreign ACE is unsupported' }
  if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) {
    $hasFullControl = $true
  }
}
if (-not $hasFullControl) { throw 'current-user full-control ACE is missing' }
[Console]::Out.Write('OK')
`;
const WINDOWS_PRIVATE_PATH_SCRIPT_BASE64 = Buffer.from(
  WINDOWS_PRIVATE_PATH_SCRIPT,
  "utf16le",
).toString("base64");

export type WindowsPrivatePathRole = "directory" | "file";

export class WindowsPrivatePathSecurityError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(`Windows private-path validation failed for ${path}`, options);
    this.name = "WindowsPrivatePathSecurityError";
  }
}

/** Initialize or verify a protected current-user-only NTFS path. */
export function assertWindowsPrivatePathSecurity(
  path: string,
  role: WindowsPrivatePathRole,
  initialize: boolean,
): void {
  if (process.platform !== "win32") return;
  const workingDirectory = win32.join(WINDOWS_SYSTEM_ROOT, "System32");
  const executable = win32.join(
    workingDirectory,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let output: Buffer;
  try {
    output = execFileSync(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        WINDOWS_PRIVATE_PATH_SCRIPT_BASE64,
      ],
      {
        cwd: workingDirectory,
        encoding: "buffer",
        env: {
          AGENC_WORKFLOW_PRIVATE_INITIALIZE: initialize ? "1" : "0",
          AGENC_WORKFLOW_PRIVATE_PATH: path,
          AGENC_WORKFLOW_PRIVATE_ROLE: role,
          APPDATA: "",
          COMSPEC: "",
          HOMEDRIVE: "",
          HOMEPATH: "",
          LOCALAPPDATA: "",
          LOGONSERVER: "",
          PATH: workingDirectory,
          PATHEXT: ".EXE",
          PSMODULEPATH: "",
          SYSTEMROOT: WINDOWS_SYSTEM_ROOT,
          TEMP: workingDirectory,
          TMP: workingDirectory,
          USERDOMAIN: "",
          USERNAME: "",
          USERPROFILE: workingDirectory,
          WINDIR: WINDOWS_SYSTEM_ROOT,
        },
        maxBuffer: WINDOWS_SECURITY_MAX_OUTPUT_BYTES,
        timeout: WINDOWS_SECURITY_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (cause) {
    throw new WindowsPrivatePathSecurityError(path, { cause });
  }
  if (output.toString("utf8") !== "OK") {
    throw new WindowsPrivatePathSecurityError(path);
  }
}
