// Cross-process local filesystem locks backed by SQLite's OS locking layer.
//
// BEGIN IMMEDIATE owns the writer reservation for the caller's critical
// section. SQLite releases it on close or process death, including SIGKILL.
// A process-wide FIFO registry prevents duplicate module instances from
// blocking one another inside synchronous SQLite calls; cross-process busy
// contention is retried asynchronously against one monotonic deadline.

import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  resolve,
  sep,
  win32,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_APPLICATION_ID = 0x41474e43; // "AGNC"
const LOCK_FORMAT_VERSION = 1;
const SQLITE_BUSY = 5;
const REGISTRY_VERSION = 1;
const REGISTRY_SYMBOL = Symbol.for("@tetsuo-ai/agenc.sqlite-lock-registry");
const MAX_BUSY_RETRY_MS = 50;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const UNSUPPORTED_FILE_ID_64 = 0xffff_ffff_ffff_ffffn;
const WINDOWS_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;
const LOCAL_FILESYSTEM_TYPES = new Set([
  "apfs", "bcachefs", "btrfs", "exfat", "ext2", "ext3", "ext4", "f2fs",
  "hfs", "hfsplus", "jfs", "msdos", "nilfs2", "ntfs", "ntfs3", "overlay",
  "ramfs", "reiserfs", "tmpfs", "ubifs", "ufs", "vfat", "xfs", "zfs",
]);
const DARWIN_ACL_READ_RIGHTS = new Set([
  "read", "list", "search", "execute", "readattr", "readextattr", "readsecurity",
]);
const DARWIN_ACL_INHERITANCE_FLAGS = new Set([
  "file_inherit", "directory_inherit", "limit_inherit", "only_inherit",
]);
const DARWIN_ACL_MUTATION_RIGHTS = new Set([
  "write", "append", "add_file", "add_subdirectory", "delete", "delete_child",
  "writeattr", "writeextattr", "writesecurity", "chown",
]);
const DARWIN_ACL_KNOWN_TOKENS = new Set([
  ...DARWIN_ACL_READ_RIGHTS,
  ...DARWIN_ACL_INHERITANCE_FLAGS,
  ...DARWIN_ACL_MUTATION_RIGHTS,
]);

const WINDOWS_SECURITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$entries = @(ConvertFrom-Json -InputObject $env:AGENC_LOCK_PATHS_JSON)
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @(
  $currentSid,
  'S-1-5-18',
  'S-1-5-32-544',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)
$leafMutationMask = [int64]852310
$ancestorMutationMask = [int64]852306
foreach ($entry in $entries) {
  $requested = [string]$entry.path
  $role = [string]$entry.role
  if (@('leafDirectory', 'ancestorDirectory', 'file') -notcontains $role) {
    throw "invalid protected-path role: $role"
  }
  $mutationMask = if ($role -eq 'ancestorDirectory') {
    $ancestorMutationMask
  } else {
    $leafMutationMask
  }
  $full = [System.IO.Path]::GetFullPath([string]$requested)
  if ($full.StartsWith('\\') -or $full.StartsWith('\\?\') -or $full.StartsWith('\\.\')) {
    throw "network and device paths are unsupported: $full"
  }
  $item = Get-Item -LiteralPath $full -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "reparse points are unsupported: $full"
  }
  $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($full))
  if (@(2, 3, 6) -notcontains [int]$drive.DriveType) {
    throw "non-local drive is unsupported: $full"
  }
  if ($drive.DriveFormat -ne 'NTFS') {
    throw "filesystem cannot enforce the required ACL contract: $full"
  }
  $acl = Get-Acl -LiteralPath $full
  if (-not $acl.AreAccessRulesCanonical) {
    throw "non-canonical ACL is unsupported: $full"
  }
  $bytes = [byte[]]::new($acl.BinaryLength)
  $acl.GetSecurityDescriptorBinaryForm($bytes, 0)
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($bytes, 0)
  if ($null -eq $raw.DiscretionaryAcl) {
    throw "null DACL is unsupported: $full"
  }
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $owner) {
    throw "untrusted owner SID on lock path: $full"
  }
  $rules = $acl.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  )
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      continue
    }
    $inheritOnly = ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
    if ($inheritOnly) {
      $childInheritance = [System.Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [System.Security.AccessControl.InheritanceFlags]::ContainerInherit
      $reachesNewChild = ($rule.InheritanceFlags -band $childInheritance) -ne 0
      if ($role -ne 'leafDirectory' -or -not $reachesNewChild) {
        continue
      }
    }
    $sid = $rule.IdentityReference.Value
    if ($trusted -notcontains $sid -and (([int64]$rule.FileSystemRights -band $mutationMask) -ne 0)) {
      throw "untrusted mutation ACE on lock path: $full"
    }
  }
}
[Console]::Out.Write('OK')
`;
const WINDOWS_SECURITY_SCRIPT_BASE64 = Buffer.from(
  WINDOWS_SECURITY_SCRIPT,
  "utf16le",
).toString("base64");

export class LocalSqliteLockTimeoutError extends Error {
  constructor({ path, label, timeoutMs, cause }) {
    super(
      `agenc: ${label} timed out after ${timeoutMs}ms waiting for local process lock ${path}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "LocalSqliteLockTimeoutError";
    this.code = "AGENC_LOCK_TIMEOUT";
    this.path = path;
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

function timeoutError(context, path, cause) {
  return new LocalSqliteLockTimeoutError({
    path,
    label: context.label,
    timeoutMs: context.timeoutMs,
    cause,
  });
}

function remainingMilliseconds(context) {
  return Math.floor(context.deadline - performance.now());
}

function throwIfExpired(context, path, cause) {
  if (remainingMilliseconds(context) <= 0) {
    throw timeoutError(context, path, cause);
  }
}

function processLockRegistry() {
  const current = process[REGISTRY_SYMBOL];
  if (current !== undefined) {
    if (
      current === null ||
      typeof current !== "object" ||
      current.version !== REGISTRY_VERSION ||
      !(current.locks instanceof Map)
    ) {
      throw new Error(
        "agenc: incompatible process-wide SQLite lock registry is already installed",
      );
    }
    return current;
  }
  const created = { version: REGISTRY_VERSION, locks: new Map() };
  Object.defineProperty(process, REGISTRY_SYMBOL, {
    value: created,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return created;
}

function acquireInProcessLock(prepared, context) {
  const registry = processLockRegistry();
  const key = prepared.identityKey;
  let state = registry.locks.get(key);
  if (state === undefined) {
    state = { locked: false, waiters: [] };
    registry.locks.set(key, state);
  }

  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next === undefined) {
        state.locked = false;
        registry.locks.delete(key);
      } else {
        clearTimeout(next.timer);
        next.resolve(makeRelease());
      }
    };
  };

  if (!state.locked) {
    throwIfExpired(context, prepared.path);
    state.locked = true;
    return Promise.resolve(makeRelease());
  }

  const remaining = remainingMilliseconds(context);
  if (remaining <= 0) {
    return Promise.reject(timeoutError(context, prepared.path));
  }
  return new Promise((resolveWait, rejectWait) => {
    const waiter = {
      resolve: resolveWait,
      timer: undefined,
    };
    const armTimeout = () => {
      const delayMs = remainingMilliseconds(context);
      if (delayMs <= 0) {
        const index = state.waiters.indexOf(waiter);
        if (index !== -1) state.waiters.splice(index, 1);
        rejectWait(timeoutError(context, prepared.path));
        return;
      }
      waiter.timer = setTimeout(armTimeout, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    };
    state.waiters.push(waiter);
    armTimeout();
  });
}

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

function pathIsWithin(path, mountPoint) {
  return path === mountPoint ||
    path.startsWith(mountPoint === sep ? mountPoint : `${mountPoint}${sep}`);
}

function execFileUtf8(file, args, options, context, path) {
  return new Promise((resolveRun, rejectRun) => {
    let deadlineTimer;
    let expired = false;
    const child = execFile(
      file,
      args,
      { ...options, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (expired) {
          rejectRun(timeoutError(context, path, error ?? undefined));
          return;
        }
        if (error !== null) {
          Object.assign(error, { stdout, stderr });
          rejectRun(error);
          return;
        }
        resolveRun({ stdout, stderr });
      },
    );
    const armDeadline = () => {
      const remaining = remainingMilliseconds(context);
      if (remaining <= 0) {
        expired = true;
        child.kill();
        return;
      }
      deadlineTimer = setTimeout(
        armDeadline,
        Math.min(remaining, MAX_TIMER_DELAY_MS),
      );
    };
    armDeadline();
  });
}

function normalizeTimedCommandError(error, context, path) {
  if (
    remainingMilliseconds(context) <= 0 ||
    error?.code === "ETIMEDOUT" ||
    error?.killed === true
  ) {
    return timeoutError(context, path, error);
  }
  return error;
}

function validateDarwinAclListing(stdout, path, role) {
  if (stdout.includes("\r")) {
    throw new Error(`agenc: Darwin ACL helper returned non-canonical output for ${path}`);
  }
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines[0].length === 0) {
    throw new Error(`agenc: Darwin ACL helper returned no metadata for ${path}`);
  }
  let previousOrdinal = -1;
  let sawLegacyOwner = false;
  for (const line of lines.slice(1)) {
    if (/^\s*owner:\s+\S.*$/u.test(line) && !sawLegacyOwner && previousOrdinal === -1) {
      sawLegacyOwner = true;
      continue;
    }
    const match = line.match(
      /^\s*(\d+):\s+(.+?)\s+(?:(inherited)\s+)?(allow|deny)\s+([a-z_]+(?:,[a-z_]+)*)\s*$/u,
    );
    if (match === null) {
      throw new Error(`agenc: Darwin ACL helper returned unrecognized output for ${path}`);
    }
    const ordinal = Number(match[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal <= previousOrdinal) {
      throw new Error(`agenc: Darwin ACL helper returned invalid ACE ordering for ${path}`);
    }
    previousOrdinal = ordinal;
    const association = match[4];
    const tokens = match[5].split(",");
    for (const token of tokens) {
      if (!DARWIN_ACL_KNOWN_TOKENS.has(token)) {
        throw new Error(`agenc: Darwin ACL helper returned unknown right ${token}: ${path}`);
      }
    }
    if (
      association === "allow" &&
      tokens.some((token) => DARWIN_ACL_MUTATION_RIGHTS.has(token))
    ) {
      throw new Error(
        `agenc: protected ${role} has a mutation-capable Darwin ACL: ${path}`,
      );
    }
  }
}

async function assertDarwinPathSecurity(path, role, context) {
  throwIfExpired(context, path);
  let result;
  try {
    result = await execFileUtf8(
      "/bin/ls",
      ["-ldeq", path],
      {
        env: { LC_ALL: "C" },
        maxBuffer: 256 * 1024,
      },
      context,
      path,
    );
  } catch (error) {
    throw normalizeTimedCommandError(error, context, path);
  }
  if (result.stderr !== "") {
    throw new Error(`agenc: Darwin ACL helper returned unexpected diagnostics for ${path}`);
  }
  validateDarwinAclListing(result.stdout, path, role);
  throwIfExpired(context, path);
}

function trustedWindowsPowerShellPath() {
  // GLOBALROOT enters the true system object-manager namespace instead of a
  // session-specific or environment-selected DOS path. Never resolve this
  // executable through PATH, SystemRoot, WINDIR, or another caller-controlled
  // value.
  return {
    systemRoot: WINDOWS_SYSTEM_ROOT,
    workingDirectory: win32.join(WINDOWS_SYSTEM_ROOT, "System32"),
    executable: win32.join(
      WINDOWS_SYSTEM_ROOT,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  };
}

function windowsPowerShellEnvironment(paths) {
  const { systemRoot, workingDirectory } = trustedWindowsPowerShellPath();
  // libuv fills a fixed set of "required" Windows variables from the parent
  // when they are absent. Define every one so poisoned caller state cannot be
  // silently inherited into the validation helper.
  return {
    AGENC_LOCK_PATHS_JSON: JSON.stringify(paths),
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
  };
}

async function assertWindowsPathSecurity(entries, context) {
  const displayPath = entries.at(-1)?.path ?? "unknown";
  throwIfExpired(context, displayPath);
  const { workingDirectory, executable } = trustedWindowsPowerShellPath();
  let result;
  try {
    result = await execFileUtf8(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        WINDOWS_SECURITY_SCRIPT_BASE64,
      ],
      {
        cwd: workingDirectory,
        env: windowsPowerShellEnvironment(entries),
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      context,
      displayPath,
    );
  } catch (error) {
    throw normalizeTimedCommandError(error, context, displayPath);
  }
  if (result.stdout !== "OK") {
    throw new Error(`agenc: Windows lock-path validation returned an invalid response for ${displayPath}`);
  }
  throwIfExpired(context, displayPath);
}

async function assertLocalFilesystem(parent, context) {
  throwIfExpired(context, parent);
  let filesystemType;
  if (process.platform === "linux") {
    const mounts = await readFile("/proc/self/mountinfo", "utf8");
    throwIfExpired(context, parent);
    let longest = -1;
    for (const line of mounts.split("\n")) {
      const fields = line.split(" ");
      const separatorIndex = fields.indexOf("-");
      if (
        separatorIndex < 6 ||
        fields[4] === undefined ||
        fields[separatorIndex + 1] === undefined
      ) continue;
      const mountPoint = decodeMountPath(fields[4]);
      if (pathIsWithin(parent, mountPoint) && mountPoint.length > longest) {
        longest = mountPoint.length;
        filesystemType = fields[separatorIndex + 1];
      }
    }
  } else if (process.platform === "darwin") {
    let stdout;
    try {
      ({ stdout } = await execFileUtf8("/sbin/mount", [], {
        env: { LC_ALL: "C" },
        maxBuffer: 4 * 1024 * 1024,
      }, context, parent));
    } catch (error) {
      throw normalizeTimedCommandError(error, context, parent);
    }
    throwIfExpired(context, parent);
    let longest = -1;
    for (const line of stdout.split("\n")) {
      const match = line.match(/ on (.+) \(([^,]+)/);
      if (match === null) continue;
      const mountPoint = decodeMountPath(match[1]);
      if (pathIsWithin(parent, mountPoint) && mountPoint.length > longest) {
        longest = mountPoint.length;
        filesystemType = match[2];
      }
    }
  } else if (process.platform === "win32") {
    await assertWindowsPathSecurity([{ path: parent, role: "leafDirectory" }], context);
    return;
  } else {
    throw new Error(
      `agenc: cannot establish lock filesystem locality on ${process.platform}`,
    );
  }
  if (filesystemType === undefined || !LOCAL_FILESYSTEM_TYPES.has(filesystemType)) {
    throw new Error(
      `agenc: non-local or unknown lock filesystem is unsupported (${filesystemType ?? "unknown"}): ${parent}`,
    );
  }
}

/**
 * Establish that an existing directory is a local, privately mutable
 * coordination boundary. Wrapper replacement uses a registry-hosted SQLite
 * lock, so a shared or attacker-writable wrapper directory would otherwise
 * permit cross-host races or path substitution outside that lock.
 */
export async function assertLocalPrivateDirectory(
  requestedPath,
  {
    timeoutMs = 60_000,
    label = "AgenC operation",
    deadline: suppliedDeadline,
    allowTrustedStickyLeaf = false,
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("lock timeoutMs must be a positive safe integer");
  }
  if (suppliedDeadline !== undefined && !Number.isFinite(suppliedDeadline)) {
    throw new TypeError("lock deadline must be finite");
  }
  if (typeof allowTrustedStickyLeaf !== "boolean") {
    throw new TypeError("allowTrustedStickyLeaf must be boolean");
  }
  const context = {
    deadline: Math.min(
      suppliedDeadline ?? Number.POSITIVE_INFINITY,
      performance.now() + timeoutMs,
    ),
    label,
    timeoutMs,
  };
  const absolute = resolve(requestedPath);
  throwIfExpired(context, absolute);
  const canonical = await realpath(absolute);
  const ancestors = [];
  for (let current = canonical; ; current = dirname(current)) {
    ancestors.push(current);
    if (dirname(current) === current) break;
  }
  const currentUid = process.getuid?.();
  const beforeIdentities = new Map();
  for (let index = 0; index < ancestors.length; index += 1) {
    const path = ancestors[index];
    const stats = await lstat(path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`agenc: protected path ancestor is not a real directory: ${path}`);
    }
    if (process.platform !== "win32") {
      const leaf = index === 0;
      const trustedOwner = stats.uid === 0n ||
        (currentUid !== undefined && stats.uid === BigInt(currentUid));
      const stickyBoundary = (!leaf || allowTrustedStickyLeaf) &&
        (stats.mode & 0o1000n) !== 0n && trustedOwner;
      if (!trustedOwner || ((stats.mode & 0o022n) !== 0n && !stickyBoundary)) {
        throw new Error(
          `agenc: protected directory chain permits untrusted mutation: ${path}; ` +
          "remove group/world write access before retrying",
        );
      }
      if (
        leaf && !stickyBoundary && currentUid !== undefined &&
        stats.uid !== BigInt(currentUid)
      ) {
        throw new Error(`agenc: protected directory is not owned by the current user: ${path}`);
      }
    }
    beforeIdentities.set(path, { dev: stats.dev, ino: stats.ino });
    identityFromStats(stats, path);
  }
  if (process.platform === "win32") {
    await assertWindowsPathSecurity(
      ancestors.map((path, index) => ({
        path,
        role: index === 0 ? "leafDirectory" : "ancestorDirectory",
      })),
      context,
    );
  } else {
    await assertLocalFilesystem(canonical, context);
    if (process.platform === "darwin") {
      for (let index = 0; index < ancestors.length; index += 1) {
        await assertDarwinPathSecurity(
          ancestors[index],
          index === 0 ? "leaf directory" : "ancestor directory",
          context,
        );
      }
    }
  }
  throwIfExpired(context, canonical);
  for (const path of ancestors) {
    const after = await lstat(path, { bigint: true });
    const before = beforeIdentities.get(path);
    if (
      !after.isDirectory() || after.isSymbolicLink() || before === undefined ||
      after.dev !== before.dev || after.ino !== before.ino
    ) {
      throw new Error(`agenc: protected directory identity changed during validation: ${path}`);
    }
  }
  return canonical;
}

function assertRegularSingleLink(stats, path) {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`agenc: lock database is not a regular file: ${path}`);
  }
  if (stats.nlink !== 1n) {
    throw new Error(`agenc: lock database must not have hard-link aliases: ${path}`);
  }
}

function identityFromStats(stats, path) {
  if (
    stats.dev === 0n ||
    stats.ino === 0n ||
    stats.ino === -1n ||
    BigInt.asUintN(64, stats.ino) === UNSUPPORTED_FILE_ID_64
  ) {
    throw new Error(`agenc: lock database has no stable filesystem identity: ${path}`);
  }
  return `${stats.dev}:${stats.ino}`;
}

function assertPosixOwnership(stats, path, kind) {
  if (process.platform === "win32") return;
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stats.uid !== BigInt(currentUid)) {
    throw new Error(`agenc: lock database ${kind} is not owned by the current user: ${path}`);
  }
  if ((stats.mode & 0o022n) !== 0n) {
    throw new Error(`agenc: lock database ${kind} is group/world-writable: ${path}`);
  }
}

/**
 * Validate a regular file and its complete directory chain before a caller
 * trusts its contents. This is intentionally non-mutating: unsafe ownership,
 * mode bits, ACLs, aliases, or identity changes fail closed.
 */
export async function assertLocalPrivateFile(
  requestedPath,
  {
    timeoutMs = 60_000,
    label = "AgenC operation",
    deadline: suppliedDeadline,
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("lock timeoutMs must be a positive safe integer");
  }
  if (suppliedDeadline !== undefined && !Number.isFinite(suppliedDeadline)) {
    throw new TypeError("lock deadline must be finite");
  }
  const context = {
    deadline: Math.min(
      suppliedDeadline ?? Number.POSITIVE_INFINITY,
      performance.now() + timeoutMs,
    ),
    label,
    timeoutMs,
  };
  const absolute = resolve(requestedPath);
  const parent = dirname(absolute);
  const canonicalParent = await assertLocalPrivateDirectory(parent, {
    timeoutMs,
    label,
    deadline: context.deadline,
  });
  if (canonicalParent !== parent) {
    throw new Error(`agenc: protected file parent must use its canonical path: ${parent}`);
  }
  throwIfExpired(context, absolute);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`agenc: protected file must be a regular single-link file: ${absolute}`);
  }
  identityFromStats(before, absolute);
  if (process.platform !== "win32") {
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && before.uid !== BigInt(currentUid)) {
      throw new Error(`agenc: protected file is not owned by the current user: ${absolute}`);
    }
    if ((before.mode & 0o022n) !== 0n) {
      throw new Error(`agenc: protected file is group/world-writable: ${absolute}`);
    }
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) {
    throw new Error(`agenc: protected file must use its canonical path: ${absolute}`);
  }
  if (process.platform === "win32") {
    await assertWindowsPathSecurity([{ path: canonical, role: "file" }], context);
  } else if (process.platform === "darwin") {
    await assertDarwinPathSecurity(canonical, "file", context);
  }
  throwIfExpired(context, canonical);
  const after = await lstat(canonical, { bigint: true });
  if (
    !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
    after.dev !== before.dev || after.ino !== before.ino
  ) {
    throw new Error(`agenc: protected file identity changed during validation: ${canonical}`);
  }
  return canonical;
}

async function prepareLockPath(requestedPath, context) {
  const absolute = resolve(requestedPath);
  throwIfExpired(context, absolute);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  throwIfExpired(context, absolute);
  const parent = await realpath(dirname(absolute));
  throwIfExpired(context, absolute);
  const validatedParent = await assertLocalPrivateDirectory(parent, {
    timeoutMs: context.timeoutMs,
    label: context.label,
    deadline: context.deadline,
  });
  if (validatedParent !== parent) {
    throw new Error(`agenc: lock database parent must use its canonical path: ${parent}`);
  }
  const parentStats = await lstat(parent, { bigint: true });
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error(`agenc: lock database parent is not a real directory: ${parent}`);
  }
  assertPosixOwnership(parentStats, parent, "parent");

  const path = join(parent, basename(absolute));
  throwIfExpired(context, path);
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  throwIfExpired(context, path);
  const pathStats = await lstat(path, { bigint: true });
  assertRegularSingleLink(pathStats, path);
  assertPosixOwnership(pathStats, path, "file");
  const canonical = await realpath(path);
  const stats = await lstat(canonical, { bigint: true });
  assertRegularSingleLink(stats, canonical);
  assertPosixOwnership(stats, canonical, "file");
  if (process.platform !== "win32") {
    await chmod(canonical, 0o600);
    if (process.platform === "darwin") {
      await assertDarwinPathSecurity(canonical, "lock database file", context);
    }
  } else {
    await assertWindowsPathSecurity([
      { path: parent, role: "leafDirectory" },
      { path: canonical, role: "file" },
    ], context);
  }
  throwIfExpired(context, canonical);
  const securedStats = await lstat(canonical, { bigint: true });
  assertRegularSingleLink(securedStats, canonical);
  assertPosixOwnership(securedStats, canonical, "file");
  return {
    path: canonical,
    parent,
    dev: securedStats.dev,
    ino: securedStats.ino,
    identityKey: identityFromStats(securedStats, canonical),
  };
}

async function revalidatePreparedLock(prepared, context) {
  throwIfExpired(context, prepared.path);
  const parentStats = await lstat(prepared.parent, { bigint: true });
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error(`agenc: lock database parent is no longer a real directory: ${prepared.parent}`);
  }
  assertPosixOwnership(parentStats, prepared.parent, "parent");
  const stats = await lstat(prepared.path, { bigint: true });
  assertRegularSingleLink(stats, prepared.path);
  assertPosixOwnership(stats, prepared.path, "file");
  if (stats.dev !== prepared.dev || stats.ino !== prepared.ino) {
    throw new Error(`agenc: lock database identity changed during acquisition: ${prepared.path}`);
  }
  if (process.platform === "win32") {
    await assertWindowsPathSecurity([
      { path: prepared.parent, role: "leafDirectory" },
      { path: prepared.path, role: "file" },
    ], context);
  } else if (process.platform === "darwin") {
    await assertDarwinPathSecurity(prepared.path, "lock database file", context);
  }
  throwIfExpired(context, prepared.path);
}

function pragmaValue(database, pragma) {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

function pragmaNumber(database, pragma) {
  const value = pragmaValue(database, pragma);
  return typeof value === "number" ? value : undefined;
}

function pragmaText(database, pragma) {
  const value = pragmaValue(database, pragma);
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

export function configureLocalSqliteLockConnection(database) {
  database.exec("PRAGMA busy_timeout = 0");
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA synchronous = EXTRA");
  database.enableDefensive(true);
  database.enableLoadExtension(false);
  if (
    pragmaNumber(database, "busy_timeout") !== 0 ||
    pragmaNumber(database, "trusted_schema") !== 0 ||
    pragmaNumber(database, "synchronous") !== 3
  ) {
    throw new Error("agenc: SQLite lock connection hardening did not take effect");
  }
}

function inspectLockDatabase(database, path) {
  const applicationId = pragmaNumber(database, "application_id");
  if (applicationId === 0) {
    const row = database.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
    ).get();
    if (row?.count !== 0) {
      throw new Error(
        `agenc: refusing to reuse an unrelated SQLite database as a lock: ${path}`,
      );
    }
    return "empty";
  }
  if (applicationId !== LOCK_APPLICATION_ID) {
    throw new Error(`agenc: lock database has an incompatible application id: ${path}`);
  }
  try {
    const schema = database.prepare(
      "SELECT type, sql FROM sqlite_schema WHERE name = 'agenc_local_process_lock'",
    ).get();
    const objects = database.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
    ).get();
    const rows = database.prepare(
      "SELECT singleton, format_version FROM agenc_local_process_lock",
    ).all();
    const normalizedSchema = typeof schema?.sql === "string"
      ? schema.sql.replace(/\s+/g, " ").trim()
      : undefined;
    if (
      schema?.type !== "table" ||
      normalizedSchema !==
        "CREATE TABLE agenc_local_process_lock ( singleton INTEGER PRIMARY KEY CHECK (singleton = 1), format_version INTEGER NOT NULL ) STRICT" ||
      objects?.count !== 1 ||
      rows.length !== 1 ||
      rows[0]?.singleton !== 1 ||
      rows[0]?.format_version !== LOCK_FORMAT_VERSION
    ) {
      throw new Error("invalid sentinel schema");
    }
  } catch (error) {
    throw new Error(`agenc: lock database has an incompatible format: ${path}`, {
      cause: error,
    });
  }
  return "valid";
}

function busyTransitionError(path, mode) {
  return Object.assign(
    new Error(`agenc: SQLite lock journal mode remained ${mode ?? "unknown"}: ${path}`),
    { errcode: SQLITE_BUSY },
  );
}

function beginAndValidateLock(database, path) {
  for (let phase = 0; phase < 8; phase += 1) {
    database.exec("BEGIN IMMEDIATE");
    const state = inspectLockDatabase(database, path);
    const journalMode = pragmaText(database, "journal_mode");
    if (journalMode !== "delete") {
      database.exec("ROLLBACK");
      const selected = pragmaText(database, "journal_mode=DELETE");
      if (selected !== "delete") throw busyTransitionError(path, selected);
      continue;
    }
    if (state === "empty") {
      database.exec(`
        PRAGMA application_id = ${LOCK_APPLICATION_ID};
        CREATE TABLE agenc_local_process_lock (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          format_version INTEGER NOT NULL
        ) STRICT;
        INSERT INTO agenc_local_process_lock (singleton, format_version)
        VALUES (1, ${LOCK_FORMAT_VERSION});
        COMMIT;
      `);
      continue;
    }
    return;
  }
  throw new Error(`agenc: lock database initialization did not converge: ${path}`);
}

function closeDatabase(database) {
  if (!database?.isOpen) return;
  const errors = [];
  try {
    if (database.isTransaction) database.exec("ROLLBACK");
  } catch (error) {
    errors.push(error);
  }
  try {
    database.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "agenc: failed to close a local process lock database");
  }
}

export function isSqliteBusyError(error) {
  return typeof error?.errcode === "number" &&
    (error.errcode & 0xff) === SQLITE_BUSY;
}

async function waitForBusyRetry(context, path, attempt, cause) {
  const remaining = remainingMilliseconds(context);
  if (remaining <= 0) throw timeoutError(context, path, cause);
  const exponentialCap = Math.min(MAX_BUSY_RETRY_MS, 2 ** Math.min(attempt, 6));
  const jitter = Math.max(1, Math.floor(Math.random() * (exponentialCap + 1)));
  await delay(Math.min(remaining, jitter));
  throwIfExpired(context, path, cause);
}

async function acquireSqliteDatabase(DatabaseSync, prepared, context) {
  let attempt = 0;
  let lastBusy;
  while (true) {
    throwIfExpired(context, prepared.path, lastBusy);
    await revalidatePreparedLock(prepared, context);
    let database;
    try {
      database = new DatabaseSync(prepared.path, {
        allowExtension: false,
        timeout: 0,
      });
      configureLocalSqliteLockConnection(database);
      await revalidatePreparedLock(prepared, context);
      beginAndValidateLock(database, prepared.path);
      throwIfExpired(context, prepared.path, lastBusy);
      return database;
    } catch (error) {
      const cleanupErrors = [];
      if (database !== undefined) {
        try {
          closeDatabase(database);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `agenc: lock attempt and cleanup both failed for ${prepared.path}`,
        );
      }
      if (!isSqliteBusyError(error)) throw error;
      lastBusy = error;
      attempt += 1;
      await waitForBusyRetry(context, prepared.path, attempt, lastBusy);
    }
  }
}

function releaseAcquired(acquired, label) {
  const errors = [];
  for (const item of acquired.toReversed()) {
    try {
      closeDatabase(item.database);
    } catch (error) {
      errors.push(error);
    }
    if ((!item.database || !item.database.isOpen) && !item.inProcessReleased) {
      try {
        item.releaseInProcess();
        item.inProcessReleased = true;
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `agenc: ${label} lock release failed`);
  }
}

export async function acquireLocalSqliteLocks(
  requestedPaths,
  {
    timeoutMs = 60_000,
    label = "AgenC operation",
    deadline: suppliedDeadline,
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("lock timeoutMs must be a positive safe integer");
  }
  if (suppliedDeadline !== undefined && !Number.isFinite(suppliedDeadline)) {
    throw new TypeError("lock deadline must be finite");
  }
  if (!Array.isArray(requestedPaths)) {
    throw new TypeError("lock paths must be an array");
  }
  if (requestedPaths.length === 0) return () => {};

  const startedAt = performance.now();
  const context = {
    deadline: Math.min(
      suppliedDeadline ?? Number.POSITIVE_INFINITY,
      startedAt + timeoutMs,
    ),
    label,
    timeoutMs,
  };
  const firstDisplayPath = resolve(requestedPaths[0]);
  throwIfExpired(context, firstDisplayPath);

  const preparedByIdentity = new Map();
  for (const requestedPath of requestedPaths) {
    throwIfExpired(context, resolve(requestedPath));
    const prepared = await prepareLockPath(requestedPath, context);
    preparedByIdentity.set(prepared.identityKey, prepared);
  }
  const preparedLocks = [...preparedByIdentity.values()].sort((left, right) =>
    left.identityKey < right.identityKey ? -1 : left.identityKey > right.identityKey ? 1 : 0);
  const pendingLocal = [];
  const acquired = [];
  let currentPath = preparedLocks[0]?.path ?? firstDisplayPath;
  try {
    for (const prepared of preparedLocks) {
      currentPath = prepared.path;
      const release = await acquireInProcessLock(prepared, context);
      pendingLocal.push({ prepared, release });
    }
    throwIfExpired(context, currentPath);
    const { DatabaseSync } = await import("node:sqlite");
    throwIfExpired(context, currentPath);
    for (const { prepared, release } of pendingLocal) {
      currentPath = prepared.path;
      const item = {
        database: undefined,
        releaseInProcess: release,
        inProcessReleased: false,
      };
      acquired.push(item);
      item.database = await acquireSqliteDatabase(DatabaseSync, prepared, context);
    }
  } catch (error) {
    const cleanupErrors = [];
    try {
      releaseAcquired(acquired, label);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    for (const { release } of pendingLocal.slice(acquired.length).toReversed()) {
      try {
        release();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    const formatted = isSqliteBusyError(error)
      ? timeoutError(context, currentPath, error)
      : error;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [formatted, ...cleanupErrors],
        `agenc: ${label} lock acquisition and rollback both failed`,
      );
    }
    throw formatted;
  }

  let released = false;
  return () => {
    if (released) return;
    releaseAcquired(acquired, label);
    released = acquired.every((item) => item.inProcessReleased);
  };
}

export async function acquireLocalSqliteLock(path, options) {
  return acquireLocalSqliteLocks([path], options);
}
