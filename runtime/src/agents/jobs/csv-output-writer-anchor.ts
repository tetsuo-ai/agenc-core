import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, join, win32 } from "node:path";
import {
  resolveTrustedWindowsSystemExecutable,
  resolveTrustedWindowsSystemPaths,
} from "../../utils/windows-system-path.js";
import { assertWindowsPrivatePathSecurity } from "../workflow-private-path.js";

const WINDOWS_LEAF_MUTATION_MASK = 0x500d0156;
const WINDOWS_ANCESTOR_MUTATION_MASK = 0x500d0152;
const WINDOWS_INHERITED_READ_MASK = 0x90000001;
const WINDOWS_CSV_PATH_TRANSPORT_MAX_CHARS = 16_384;
const WINDOWS_CSV_PATH_TRANSPORT_MAX_ENTRIES = 128;

/** Revert-sensitive visibility for the ACL policy's generic-right expansion. */
export function __csvOutputWindowsAclMasksForTesting(): {
  readonly leafMutation: number;
  readonly ancestorMutation: number;
  readonly inheritedRead: number;
} {
  return {
    leafMutation: WINDOWS_LEAF_MUTATION_MASK,
    ancestorMutation: WINDOWS_ANCESTOR_MUTATION_MASK,
    inheritedRead: WINDOWS_INHERITED_READ_MASK,
  };
}

const WINDOWS_MUTATION_BOUNDARY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# Keep this direct-.NET only: module autoload can exhaust the bounded probe.
$transport = [string]$env:AGENC_CSV_PATHS
if ([string]::IsNullOrEmpty($transport) -or $transport.Length -gt ${WINDOWS_CSV_PATH_TRANSPORT_MAX_CHARS}) {
  throw 'invalid path transport'
}
$entries = [string[]]$transport.Split([char]10)
if ($entries.Count -lt 1 -or $entries.Count -gt ${WINDOWS_CSV_PATH_TRANSPORT_MAX_ENTRIES}) {
  throw 'invalid path transport'
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @(
  $currentSid,
  'S-1-5-18',
  'S-1-5-32-544',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)
$creatorOwnerSid = 'S-1-3-0'
$leafMutationMask = [int64]${WINDOWS_LEAF_MUTATION_MASK}
$ancestorMutationMask = [int64]${WINDOWS_ANCESTOR_MUTATION_MASK}
$inheritedReadMask = [int64]${WINDOWS_INHERITED_READ_MASK}
foreach ($entry in $entries) {
  $separator = $entry.IndexOf([char]58)
  if ($separator -lt 1 -or $separator -eq ($entry.Length - 1)) { throw 'invalid path transport' }
  $role = $entry.Substring(0, $separator)
  if (@('leafDirectory', 'ancestorDirectory') -notcontains $role) { throw 'invalid role' }
  $encodedPath = $entry.Substring($separator + 1)
  if (($encodedPath.Length % 4) -ne 0) { throw 'invalid path transport' }
  $pathBytes = [System.Convert]::FromBase64String($encodedPath)
  if (($pathBytes.Length % 2) -ne 0) { throw 'invalid path transport' }
  if ([System.Convert]::ToBase64String($pathBytes) -cne $encodedPath) {
    throw 'non-canonical path transport'
  }
  $pathCharacters = [char[]]::new([int]($pathBytes.Length / 2))
  for ($index = 0; $index -lt $pathCharacters.Length; $index += 1) {
    $byteOffset = $index * 2
    $lowByte = [int]$pathBytes[$byteOffset]
    $highByte = [int]$pathBytes[$byteOffset + 1]
    $pathCharacters[$index] = [char]($lowByte -bor ($highByte -shl 8))
  }
  $decodedPath = [string]::new($pathCharacters)
  $mask = if ($role -eq 'ancestorDirectory') { $ancestorMutationMask } else { $leafMutationMask }
  $full = [System.IO.Path]::GetFullPath($decodedPath)
  if ($full.StartsWith('\\') -or $full.StartsWith('\\?\') -or $full.StartsWith('\\.\')) {
    throw "network and device paths are unsupported: $full"
  }
  $attributes = [System.IO.File]::GetAttributes($full)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "reparse points are unsupported: $full"
  }
  $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($full))
  if (@(2, 3, 6) -notcontains [int]$drive.DriveType -or $drive.DriveFormat -ne 'NTFS') {
    throw "local NTFS is required: $full"
  }
  $aclSections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
  $acl = [System.IO.Directory]::GetAccessControl($full, $aclSections)
  if (-not $acl.AreAccessRulesCanonical) { throw "non-canonical ACL: $full" }
  $bytes = $acl.GetSecurityDescriptorBinaryForm()
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($bytes, 0)
  if ($null -eq $raw.DiscretionaryAcl) { throw "null DACL: $full" }
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $owner) { throw "untrusted owner: $full" }
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    $sid = $rule.IdentityReference.Value
    $untrusted = $trusted -notcontains $sid -and $sid -ne $creatorOwnerSid
    $rights = ([int64]$rule.FileSystemRights) -band [int64]4294967295
    $objectInherit = ($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0
    if ($role -eq 'leafDirectory' -and $untrusted -and $objectInherit -and (($rights -band $inheritedReadMask) -ne 0)) {
      throw "untrusted inherited read ACE: $full"
    }
    $inheritOnly = ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
    if ($inheritOnly) {
      $childInheritance = [System.Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [System.Security.AccessControl.InheritanceFlags]::ContainerInherit
      $reachesNewChild = ($rule.InheritanceFlags -band $childInheritance) -ne 0
      if ($role -ne 'leafDirectory' -or -not $reachesNewChild) { continue }
    }
    if ($untrusted -and (($rights -band $mask) -ne 0)) {
      throw "untrusted mutation ACE: $full"
    }
  }
}
[Console]::Out.Write('OK')
`;
const WINDOWS_MUTATION_BOUNDARY_SCRIPT_BASE64 = Buffer.from(
  WINDOWS_MUTATION_BOUNDARY_SCRIPT,
  "utf16le",
).toString("base64");
const DARWIN_ACL_KNOWN_RIGHTS = new Set([
  "read",
  "list",
  "search",
  "execute",
  "readattr",
  "readextattr",
  "readsecurity",
  "write",
  "append",
  "add_file",
  "add_subdirectory",
  "delete",
  "delete_child",
  "writeattr",
  "writeextattr",
  "writesecurity",
  "chown",
  "file_inherit",
  "directory_inherit",
  "limit_inherit",
  "only_inherit",
]);
const DARWIN_ACL_MUTATION_RIGHTS = new Set([
  "write",
  "append",
  "add_file",
  "add_subdirectory",
  "delete",
  "delete_child",
  "writeattr",
  "writeextattr",
  "writesecurity",
  "chown",
]);

function validateDarwinCsvAcl(
  path: string,
  role: "leafDirectory" | "ancestorDirectory" | "privatePath",
): void {
  const output = execFileSync("/bin/ls", ["-ldeq", path], {
    encoding: "utf8",
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: 262_144,
    timeout: 30_000,
  });
  if (output.includes("\r")) {
    throw new Error(`Darwin CSV ACL metadata is non-canonical: ${path}`);
  }
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines[0]!.length === 0) {
    throw new Error(`Darwin CSV ACL metadata is missing: ${path}`);
  }
  let previousOrdinal = -1;
  let sawLegacyOwner = false;
  for (const line of lines.slice(1)) {
    if (
      /^\s*owner:\s+\S.*$/u.test(line) &&
      !sawLegacyOwner &&
      previousOrdinal === -1
    ) {
      sawLegacyOwner = true;
      continue;
    }
    const match = line.match(
      /^\s*(\d+):\s+(.+?)\s+(?:(inherited)\s+)?(allow|deny)\s+([a-z_]+(?:,[a-z_]+)*)\s*$/u,
    );
    if (match === null) {
      throw new Error(`Darwin CSV ACL metadata is unrecognized: ${path}`);
    }
    const ordinal = Number(match[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal <= previousOrdinal) {
      throw new Error(`Darwin CSV ACL ordering is invalid: ${path}`);
    }
    previousOrdinal = ordinal;
    const rights = match[5]!.split(",");
    if (rights.some((right) => !DARWIN_ACL_KNOWN_RIGHTS.has(right))) {
      throw new Error(`Darwin CSV ACL contains an unknown right: ${path}`);
    }
    if (
      match[4] === "allow" &&
      (rights.some((right) => DARWIN_ACL_MUTATION_RIGHTS.has(right)) ||
        (role === "leafDirectory" && rights.includes("file_inherit")))
    ) {
      throw new Error(
        `Darwin CSV path permits ACL mutation or inherited read: ${path}`,
      );
    }
  }
}

/** Validate the APFS/HFS ACL chain that governs capture entry replacement. */
export function assertDarwinCsvMutationBoundary(parentPath: string): void {
  if (process.platform !== "darwin") return;
  for (let current = parentPath, index = 0; ; current = dirname(current)) {
    validateDarwinCsvAcl(
      current,
      index === 0 ? "leafDirectory" : "ancestorDirectory",
    );
    if (dirname(current) === current) break;
    index += 1;
  }
}

/** Strip inherited ACLs from a newly created CSV-private path, then verify. */
export function initializeDarwinCsvPrivatePath(path: string): void {
  if (process.platform !== "darwin") return;
  execFileSync("/bin/chmod", ["-N", path], {
    encoding: "buffer",
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: 262_144,
    timeout: 30_000,
  });
  validateDarwinCsvAcl(path, "privatePath");
}

/** Verify that another Windows user cannot replace capture-parent entries. */
export function assertWindowsCsvMutationBoundary(parentPath: string): void {
  if (process.platform !== "win32") return;
  const entries: Array<{
    readonly path: string;
    readonly role: "leafDirectory" | "ancestorDirectory";
  }> = [];
  for (
    let current = parentPath, index = 0;
    ;
    current = win32.dirname(current)
  ) {
    entries.push({
      path: current,
      role: index === 0 ? "leafDirectory" : "ancestorDirectory",
    });
    if (win32.dirname(current) === current) break;
    index += 1;
  }
  const windowsPaths = resolveTrustedWindowsSystemPaths();
  const { systemRoot, system32: workingDirectory } = windowsPaths;
  const executable = resolveTrustedWindowsSystemExecutable(windowsPaths, [
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ]);
  const pathTransport = entries
    .map(
      ({ path, role }) =>
        `${role}:${Buffer.from(path, "utf16le").toString("base64")}`,
    )
    .join("\n");
  if (pathTransport.length > WINDOWS_CSV_PATH_TRANSPORT_MAX_CHARS) {
    throw new Error("Windows CSV path transport exceeds its limit");
  }
  const output = execFileSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      WINDOWS_MUTATION_BOUNDARY_SCRIPT_BASE64,
    ],
    {
      cwd: workingDirectory,
      encoding: "buffer",
      env: {
        AGENC_CSV_PATHS: pathTransport,
        APPDATA: "",
        COMSPEC: "",
        HOMEDRIVE: "",
        HOMEPATH: "",
        LOCALAPPDATA: "",
        LOGONSERVER: "",
        PATH: workingDirectory,
        PATHEXT: ".EXE",
        PSMODULEPATH: "",
        SYSTEMDRIVE: "",
        SYSTEMROOT: systemRoot,
        TEMP: workingDirectory,
        TMP: workingDirectory,
        USERDOMAIN: "",
        USERNAME: "",
        USERPROFILE: workingDirectory,
        WINDIR: systemRoot,
      },
      maxBuffer: 1_048_576,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (output.toString("utf8") !== "OK") {
    throw new Error("Windows CSV mutation-boundary validation failed");
  }
}

export interface CsvOutputWriterIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  /** Diagnostic only; the hardlink anchor is the generation proof. */
  readonly birthtimeNs: bigint;
}

export interface CsvOutputWriterAnchorPaths {
  readonly directoryPath: string;
  readonly anchorPath: string;
  readonly authorityPath: string;
  readonly candidatePath: string;
  readonly targetAnchorPath: string;
  readonly targetCandidatePath: string;
}

let afterFirstWriterAnchorForTesting: (() => void) | undefined;

/** Test seam for a public-temporary swap between the two durable links. */
export function __setCsvOutputAfterFirstWriterAnchorForTesting(
  hook: (() => void) | undefined,
): void {
  afterFirstWriterAnchorForTesting = hook;
}

/**
 * Derive a fixed-size private anchor name solely from durable intent fields.
 * Recovery can therefore find every intermediate without a random side log.
 * The 0700 directory excludes other OS users; like the writable output root
 * itself, it assumes processes running as the owning UID are trusted.
 */
export function csvOutputWriterAnchorPaths(
  temporaryPath: string,
  intentId: string,
  identity: CsvOutputWriterIdentity,
): CsvOutputWriterAnchorPaths {
  const token = createHash("sha256")
    .update(temporaryPath, "utf8")
    .update("\0", "utf8")
    .update(intentId, "utf8")
    .update("\0", "utf8")
    .update(identity.dev.toString(), "utf8")
    .update(":", "utf8")
    .update(identity.ino.toString(), "utf8")
    .digest("hex")
    .slice(0, 24);
  const directoryPath = join(dirname(temporaryPath), `.${token}.capture`);
  return {
    directoryPath,
    anchorPath: join(directoryPath, "anchor"),
    authorityPath: join(directoryPath, "authority"),
    candidatePath: join(directoryPath, "candidate"),
    targetAnchorPath: join(directoryPath, "target-anchor"),
    targetCandidatePath: join(directoryPath, "target-candidate"),
  };
}

/**
 * Establish two durable private references while the caller still holds the
 * writer FD. Once either reference exists, that inode cannot be recycled.
 * The pending database row is intentionally left recoverable on any failure.
 */
export function establishCsvOutputWriterAnchorsSync(
  paths: CsvOutputWriterAnchorPaths,
  temporaryPath: string,
  expected: CsvOutputWriterIdentity,
): void {
  mkdirSync(paths.directoryPath, { mode: 0o700 });
  initializeDarwinCsvPrivatePath(paths.directoryPath);
  assertWindowsPrivatePathSecurity(paths.directoryPath, "directory", true);
  assertPrivateAnchorDirectorySync(paths.directoryPath);
  linkSync(temporaryPath, paths.anchorPath);
  assertAnchoredWriterSync(paths.anchorPath, expected, 2n);
  afterFirstWriterAnchorForTesting?.();
  // The first link has already been validated against the writer identity.
  // Deriving the authority from it prevents a public-path swap from mixing
  // two inode generations into one supposedly durable anchor set.
  linkSync(paths.anchorPath, paths.authorityPath);
  let publicWriter: ReturnType<typeof lstatSync> | undefined;
  try {
    publicWriter = lstatSync(temporaryPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const publicStillOwned =
    publicWriter !== undefined &&
    !publicWriter.isSymbolicLink() &&
    publicWriter.isFile() &&
    publicWriter.dev === expected.dev &&
    publicWriter.ino === expected.ino;
  const expectedLinks = publicStillOwned ? 3n : 2n;
  assertAnchoredWriterSync(paths.anchorPath, expected, expectedLinks);
  assertAnchoredWriterSync(paths.authorityPath, expected, expectedLinks);
  syncDirectorySync(paths.directoryPath);
  syncDirectorySync(dirname(temporaryPath));
  if (!publicStillOwned) {
    throw new Error("CSV output temporary changed while anchoring its writer");
  }
}

function assertPrivateAnchorDirectorySync(path: string): void {
  const stats = lstatSync(path, { bigint: true });
  const currentUid = process.getuid?.();
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (process.platform !== "win32" && (stats.mode & 0o077n) !== 0n) ||
    (currentUid !== undefined && stats.uid !== BigInt(currentUid))
  ) {
    throw new Error("CSV output writer anchor is not a private directory");
  }
}

function assertAnchoredWriterSync(
  path: string,
  expected: CsvOutputWriterIdentity,
  expectedLinks: bigint,
): void {
  const stats = lstatSync(path, { bigint: true });
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.dev !== expected.dev ||
    stats.ino !== expected.ino ||
    stats.nlink !== expectedLinks
  ) {
    throw new Error("CSV output writer anchor identity changed");
  }
}

function syncDirectorySync(path: string): void {
  const descriptor = openSync(
    path,
    (process.platform === "win32" ? fsConstants.O_RDWR : fsConstants.O_RDONLY) |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_DIRECTORY ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
