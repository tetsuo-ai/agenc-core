import fs from "node:fs";
import path from "node:path";
import { canonicalAuthorityPath, isWithinAuthorityPath } from "../desktop-authority-protection.js";

import {
  hasFullDiskReadAccess,
  hasFullDiskWriteAccess,
  canWritePathWithCwd,
  getReadableRootsWithCwd,
  getUnreadableGlobsWithCwd,
  getUnreadableRootsWithCwd,
  getWritableRootsWithCwd,
  includePlatformDefaults,
  normalizePathForPolicy,
  pathStartsWith,
  resolvePermissionPath,
  type FileSystemSandboxPolicy,
  type WritableRoot,
} from "../engine/index.js";
import {
  INHERITED_CWD_FD,
  INHERITED_CWD_SANDBOX_PATH,
} from "./config.js";
import type { BoundReadOnlyCwdIdentity } from "../bound-readonly-cwd.js";

export type BwrapNetworkMode = "full-access" | "isolated" | "proxy-only";

export interface BwrapOptions {
  readonly mountProc: boolean;
  readonly networkMode: BwrapNetworkMode;
  readonly sessionTempRoot: string;
  readonly seccompFd?: number;
  readonly extraReadOnlyBindRoots?: readonly string[];
  readonly extraWritableBindRoots?: readonly string[];
  /**
   * Host device nodes to `--dev-bind` into the sandbox after `--dev /dev`
   * builds the minimal devtmpfs. Without this an ESP32 on /dev/ttyUSB0 is
   * visible in sysfs but cannot be opened for flashing or serial from inside
   * the sandbox — the whole point of an embedded workflow. Opt-in, absolute
   * /dev/* paths only (see resolveSandboxDeviceBinds).
   */
  readonly extraDeviceBindPaths?: readonly string[];
  readonly inheritedReadOnlyCwd?: boolean;
  readonly boundReadOnlyCwd?: BoundReadOnlyCwdIdentity;
}

export interface BwrapCommandArgs {
  readonly args: readonly string[];
  readonly usesBubblewrap: boolean;
  readonly protectedCreateTargets: readonly string[];
}

const MAX_UNREADABLE_GLOB_MATCHES = 4096;
const MAX_UNREADABLE_GLOB_VISITS = 20000;

export function createBwrapCommandArgs(
  command: readonly string[],
  fileSystemSandboxPolicy: FileSystemSandboxPolicy,
  sandboxPolicyCwd: string,
  commandCwd: string,
  options: BwrapOptions,
): BwrapCommandArgs {
  const unreadableGlobs = getUnreadableGlobsWithCwd(
    fileSystemSandboxPolicy,
    sandboxPolicyCwd,
  );
  const fullWrite =
    hasFullDiskWriteAccess(fileSystemSandboxPolicy) &&
    unreadableGlobs.length === 0;
  if (options.inheritedReadOnlyCwd === true && fullWrite) {
    throw new Error(
      "inherited read-only cwd requires a restricted filesystem policy",
    );
  }
  if (
    options.inheritedReadOnlyCwd === true &&
    ((options.boundReadOnlyCwd === undefined && !hasFullDiskReadAccess(fileSystemSandboxPolicy)) ||
      unreadableGlobs.length > 0)
  ) {
    throw new Error(
      "inherited read-only cwd requires full disk-read policy without deny globs",
    );
  }
  if (options.boundReadOnlyCwd !== undefined) {
    if (options.inheritedReadOnlyCwd !== true || hasFullDiskReadAccess(fileSystemSandboxPolicy) ||
        fileSystemSandboxPolicy.entries.some(entry => entry.access !== "read" || entry.path.kind === "glob")) {
      throw new Error("invalid narrow inherited cwd policy");
    }
    const roots = [
      ...getReadableRootsWithCwd(fileSystemSandboxPolicy, sandboxPolicyCwd, options.sessionTempRoot),
      ...(includePlatformDefaults(fileSystemSandboxPolicy) ? ["/bin", "/sbin", "/lib", "/lib64", "/usr", "/etc", "/nix/store", "/run/current-system/sw"] : []),
      ...(options.extraReadOnlyBindRoots ?? []),
    ];
    for (const root of roots) {
      if (root === INHERITED_CWD_SANDBOX_PATH) continue;
      const canonical = canonicalAuthorityPath(root);
      if ([root, canonical].some(candidate =>
        isWithinAuthorityPath(candidate, options.boundReadOnlyCwd!.path) || isWithinAuthorityPath(options.boundReadOnlyCwd!.path, candidate) ||
        isWithinAuthorityPath(INHERITED_CWD_SANDBOX_PATH, candidate))) {
        throw new Error("narrow inherited cwd cannot retain an overlapping public read mount");
      }
    }
    if ((options.extraWritableBindRoots?.length ?? 0) > 0 || (options.extraDeviceBindPaths?.length ?? 0) > 0) {
      throw new Error("narrow inherited cwd cannot retain writable or device mounts");
    }
  }
  if (fullWrite && options.networkMode === "full-access" && options.seccompFd === undefined) {
    return { args: [...command], usesBubblewrap: false, protectedCreateTargets: [] };
  }
  const protectedCreateTargets: string[] = [];

  const args = fullWrite
    ? createBwrapFlagsFullFilesystem(command, options)
    : createBwrapFlags(
        command,
        fileSystemSandboxPolicy,
        sandboxPolicyCwd,
        commandCwd,
        options,
        protectedCreateTargets,
      );
  return {
    args,
    usesBubblewrap: true,
    protectedCreateTargets,
  };
}

export function insertInnerCommandArgv0(
  bwrapArgs: readonly string[],
  supportsArgv0: boolean,
  fallbackCommand: string,
): string[] {
  const args = [...bwrapArgs];
  const separatorIndex = args.indexOf("--");
  if (separatorIndex === -1) {
    throw new Error("bubblewrap argv is missing command separator");
  }
  if (supportsArgv0) {
    args.splice(separatorIndex, 0, "--argv0", "agenc-linux-sandbox");
  } else if (args[separatorIndex + 1] !== undefined) {
    args[separatorIndex + 1] = fallbackCommand;
  }
  return args;
}

function createBwrapFlagsFullFilesystem(
  command: readonly string[],
  options: BwrapOptions,
): string[] {
  const args = [
    "--new-session",
    "--die-with-parent",
    "--bind",
    "/",
    "/",
  ];
  appendProcMask(args, options);
  args.push("--unshare-user", "--unshare-pid");
  appendNamespaceArgs(args, options);
  args.push("--");
  args.push(...command);
  return args;
}

function createBwrapFlags(
  command: readonly string[],
  fileSystemSandboxPolicy: FileSystemSandboxPolicy,
  sandboxPolicyCwd: string,
  commandCwd: string,
  options: BwrapOptions,
  protectedCreateTargets: string[],
): string[] {
  const filesystem = createFilesystemArgs(
    fileSystemSandboxPolicy,
    sandboxPolicyCwd,
    commandCwd,
    options,
    protectedCreateTargets,
  );
  const args = [
    "--new-session",
    "--die-with-parent",
    ...filesystem.args,
    "--unshare-user",
    "--unshare-pid",
  ];
  appendNamespaceArgs(args, options);
  const normalizedCommandCwd =
    options.inheritedReadOnlyCwd === true
      ? INHERITED_CWD_SANDBOX_PATH
      : filesystem.commandCwd;
  if (
    options.inheritedReadOnlyCwd === true ||
    normalizedCommandCwd !== normalizePathForPolicy(commandCwd)
  ) {
    args.push("--chdir", normalizedCommandCwd);
  }
  args.push("--");
  args.push(...command);
  return args;
}

function appendProcMask(args: string[], options: BwrapOptions): void {
  // When a private procfs is not mounted, the host /proc bound via the root
  // bind would otherwise stay visible, leaking other same-UID processes'
  // environ/cmdline/maps. Mask it with an empty tmpfs so host procfs is never
  // exposed. When mountProc is true, appendNamespaceArgs mounts a fresh procfs
  // over this path afterwards.
  if (!options.mountProc) {
    args.push("--tmpfs", "/proc");
  }
}

function appendNamespaceArgs(args: string[], options: BwrapOptions): void {
  if (options.networkMode !== "full-access") {
    args.push("--unshare-net");
  }
  if (options.seccompFd !== undefined) {
    args.push("--seccomp", String(options.seccompFd));
  }
  if (options.mountProc) {
    args.push("--proc", "/proc");
  }
}

function createFilesystemArgs(
  policy: FileSystemSandboxPolicy,
  sandboxPolicyCwd: string,
  commandCwd: string,
  options: BwrapOptions,
  protectedCreateTargets: string[],
): { readonly args: string[]; readonly commandCwd: string } {
  const args: string[] = [];
  const writableRoots = getWritableRootsWithCwd(
    policy,
    sandboxPolicyCwd,
    options.sessionTempRoot,
  );
  assertAliasedCarveouts(policy, writableRoots, sandboxPolicyCwd, options.sessionTempRoot);
  if (
    options.inheritedReadOnlyCwd === true &&
    writableRoots.length > 0
  ) {
    throw new Error(
      "inherited read-only cwd cannot retain writable filesystem roots",
    );
  }
  if (hasFullDiskReadAccess(policy)) {
    args.push("--ro-bind", "/", "/");
  } else {
    args.push("--tmpfs", "/");
    if (includePlatformDefaults(policy)) {
      appendReadOnlyIfExists(args, "/bin");
      appendReadOnlyIfExists(args, "/sbin");
      appendReadOnlyIfExists(args, "/lib");
      appendReadOnlyIfExists(args, "/lib64");
      appendReadOnlyIfExists(args, "/usr");
      appendReadOnlyIfExists(args, "/etc");
      appendReadOnlyIfExists(args, "/nix/store");
      appendReadOnlyIfExists(args, "/run/current-system/sw");
    }
    for (
      const root of getReadableRootsWithCwd(
        policy,
        sandboxPolicyCwd,
        options.sessionTempRoot,
      )
    ) {
      if (options.boundReadOnlyCwd !== undefined && root === INHERITED_CWD_SANDBOX_PATH) continue;
      appendReadOnlyIfExists(args, root);
    }
  }

  appendProcMask(args, options);

  args.push("--dev", "/dev");

  // Bind requested host device nodes over the minimal devtmpfs. --dev-bind is
  // read-write on purpose: flashing and serial both need to open the tty for
  // write. Only paths that passed resolveSandboxDeviceBinds (absolute, under
  // /dev, character/block devices) reach here.
  for (const devicePath of options.extraDeviceBindPaths ?? []) {
    args.push("--dev-bind", devicePath, devicePath);
  }

  if (options.inheritedReadOnlyCwd === true) {
    appendInheritedReadOnlyCwd(args);
  }

  const unreadableTargets = [
    ...getUnreadableRootsWithCwd(
      policy,
      sandboxPolicyCwd,
      options.sessionTempRoot,
    ),
    ...expandUnreadableGlobMatches(
      getUnreadableGlobsWithCwd(policy, sandboxPolicyCwd),
      sandboxPolicyCwd,
      policy.globScanMaxDepth,
    ),
  ];
  const isNestedUnreadable = (target: string) =>
    writableRoots.some((root) => isWithinAuthorityPath(
      canonicalAuthorityPath(target), canonicalAuthorityPath(root.root),
    ));
  for (const root of unreadableTargets.filter((target) => !isNestedUnreadable(target))) {
    appendMask(args, root, writableRoots);
  }
  for (const root of writableRoots) {
    appendWritableRoot(args, root, protectedCreateTargets);
  }
  for (const root of options.extraReadOnlyBindRoots ?? []) {
    appendReadOnlyIfExists(args, root);
  }
  for (const root of options.extraWritableBindRoots ?? []) {
    const canonical = canonicalAuthorityPath(root);
    if ((policy.reservedReadOnlyPaths ?? []).some((reserved) =>
      isWithinAuthorityPath(canonical, reserved) || isWithinAuthorityPath(reserved, canonical)
    )) throw new Error("extra writable bind overlaps reserved Desktop authority");
    appendBindIfExists(args, root);
  }
  for (const root of unreadableTargets.filter(isNestedUnreadable)) {
    appendMask(args, root, writableRoots);
  }
  return physicalFilesystemArgs(
    args,
    [sandboxPolicyCwd, commandCwd, ...protectedCreateTargets],
    [...writableRoots.map((root) => root.root), ...(options.extraWritableBindRoots ?? [])],
    commandCwd,
    protectedCreateTargets,
    options.boundReadOnlyCwd === undefined ? undefined : {
      identity: options.boundReadOnlyCwd,
      explicitReadRoots: policy.entries.flatMap(entry => entry.path.kind === "path" ? [entry.path.path] : []),
    },
  );
}

function assertAliasedCarveouts(
  policy: FileSystemSandboxPolicy,
  roots: readonly WritableRoot[],
  cwd: string,
  temp: string,
): void {
  // The engine deliberately preserves lexical policy paths. Do not let a
  // physical mount overwrite a differently spelled restriction that the
  // engine could not associate with its writable root.
  for (const entry of policy.entries) {
    if (entry.access === "write") continue;
    const target = resolvePermissionPath(entry.path, cwd, temp);
    if (target === null || canWritePathWithCwd(policy, target, cwd, temp)) continue;
    const physical = canonicalAuthorityPath(target);
    for (const root of roots) {
      rejectSymlinkCrossing(target, root.root, "restricted path");
      if (!isWithinAuthorityPath(physical, canonicalAuthorityPath(root.root))) continue;
      if (root.readOnlySubpaths.some((carveout) =>
        isWithinAuthorityPath(physical, canonicalAuthorityPath(carveout))
      )) continue;
      throw new Error(`cannot enforce differently spelled restriction inside aliased writable root: ${target}`);
    }
  }
}

interface AliasObservation {
  readonly target: string;
  readonly device: number;
  readonly inode: number;
}

interface FilesystemAliasSnapshot {
  readonly aliases: ReadonlyMap<string, AliasObservation>;
  readonly physicalPaths: ReadonlyMap<string, string>;
}

function isNamespaceFilesystemPath(target: string): boolean {
  return ["/", "/proc", "/dev", "/dev/null", INHERITED_CWD_SANDBOX_PATH].includes(target);
}

function captureFilesystemAliases(
  hostPaths: readonly string[],
  writablePaths: readonly string[],
): FilesystemAliasSnapshot {
  const aliases = new Map<string, AliasObservation>();
  const observed = new Set<string>();
  const physicalPaths = new Map<string, string>();
  const writableAuthorities = writablePaths.map((root) => ({
    lexical: normalizePathForPolicy(root),
    physical: canonicalAuthorityPath(root),
  }));
  const observeAliases = (target: string): void => {
    const normalized = normalizePathForPolicy(target);
    if (observed.has(normalized)) return;
    observed.add(normalized);
    let current: string = path.sep;
    for (const part of normalized.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let metadata: fs.Stats;
      try { metadata = fs.lstatSync(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      if (!metadata.isSymbolicLink()) continue;
      const physicalParent = canonicalAuthorityPath(path.dirname(current));
      const location = path.join(physicalParent, path.basename(current));
      // The link's target may be read-only while its directory entry remains
      // replaceable through another writable grant. Refuse that topology.
      if (writableAuthorities.some((root) =>
        isWithinAuthorityPath(current, root.lexical) ||
        isWithinAuthorityPath(path.dirname(current), root.lexical) ||
        isWithinAuthorityPath(location, root.physical) ||
        isWithinAuthorityPath(physicalParent, root.physical)
      )) {
        throw new Error(`cannot enforce sandbox alias inside writable authority: ${current}`);
      }
      const observation = {
        target: fs.readlinkSync(current), device: metadata.dev, inode: metadata.ino,
      };
      const previous = aliases.get(location);
      if (previous !== undefined && (
        previous.target !== observation.target || previous.device !== observation.device ||
        previous.inode !== observation.inode
      )) throw new Error(`sandbox alias changed while planning: ${current}`);
      aliases.set(location, observation);
      if (aliases.size > 256) throw new Error("sandbox alias expansion exceeded 256 links");
      observeAliases(path.resolve(path.dirname(current), observation.target));
    }
  };
  for (const target of new Set([...hostPaths, ...writablePaths])) {
    if (isNamespaceFilesystemPath(target)) continue;
    observeAliases(target);
    physicalPaths.set(target, canonicalAuthorityPath(target));
  }
  // Verify that the separately observed links actually explain every realpath.
  // A link disappearing between realpath/lstat must not hide an alias race.
  for (const [target, physical] of physicalPaths) {
    let pending = normalizePathForPolicy(target).split(path.sep).filter(Boolean);
    let resolved: string = path.sep;
    let followed = 0;
    while (pending.length > 0) {
      resolved = path.join(resolved, pending.shift()!);
      const alias = aliases.get(resolved);
      if (alias === undefined) continue;
      if (++followed > 256) throw new Error("sandbox alias resolution exceeded 256 links");
      pending = [
        ...path.resolve(path.dirname(resolved), alias.target).split(path.sep).filter(Boolean),
        ...pending,
      ];
      resolved = path.sep;
    }
    if (resolved !== physical) throw new Error(`sandbox alias changed while planning: ${target}`);
  }
  return { aliases, physicalPaths };
}

function assertFilesystemAliasesUnchanged(
  before: FilesystemAliasSnapshot,
  after: FilesystemAliasSnapshot,
): void {
  if (before.aliases.size !== after.aliases.size || before.physicalPaths.size !== after.physicalPaths.size) {
    throw new Error("sandbox alias changed while planning");
  }
  for (const [target, physical] of before.physicalPaths) {
    if (after.physicalPaths.get(target) !== physical) throw new Error(`sandbox alias changed while planning: ${target}`);
  }
  for (const [location, alias] of before.aliases) {
    const current = after.aliases.get(location);
    if (current?.target !== alias.target || current.device !== alias.device || current.inode !== alias.inode) {
      throw new Error(`sandbox alias changed while planning: ${location}`);
    }
  }
}

function physicalFilesystemArgs(
  args: readonly string[],
  aliasPaths: readonly string[],
  writablePaths: readonly string[],
  commandCwd: string,
  protectedCreateTargets: string[],
  boundReadOnly?: { readonly identity: BoundReadOnlyCwdIdentity; readonly explicitReadRoots: readonly string[] },
): { readonly args: string[]; readonly commandCwd: string } {
  const narrow = args[0] === "--tmpfs" && args[1] === "/";
  const hostPaths = [...aliasPaths, ...(boundReadOnly?.explicitReadRoots ?? [])];
  const bindPaths = new Set<string>();
  const translate = (physical: (target: string) => string): string[] => {
    const translated: string[] = [];
    for (let index = 0; index < args.length;) {
      const flag = args[index++]!;
      translated.push(flag);
      switch (flag) {
        case "--bind":
        case "--ro-bind":
          bindPaths.add(args[index]!);
          bindPaths.add(args[index + 1]!);
          translated.push(physical(args[index++]!), physical(args[index++]!));
          break;
        case "--dev-bind":
        case "--ro-bind-fd":
          translated.push(args[index++]!, args[index++]!);
          break;
        case "--dir":
        case "--tmpfs":
        case "--remount-ro":
          translated.push(physical(args[index++]!));
          break;
        case "--dev":
          translated.push(args[index++]!);
          break;
        default:
          throw new Error(`unsupported sandbox filesystem flag: ${flag}`);
      }
    }
    return translated;
  };
  translate((target) => { hostPaths.push(target); return target; });
  const snapshot = captureFilesystemAliases(hostPaths, writablePaths);
  const physical = (target: string): string => {
    if (isNamespaceFilesystemPath(target)) return target;
    const resolved = snapshot.physicalPaths.get(target);
    if (resolved === undefined) throw new Error(`unobserved sandbox filesystem path: ${target}`);
    return resolved;
  };
  if (boundReadOnly !== undefined) {
    // Use the same observed identities and paths that generate the mounts.
    // A coherent retarget between an earlier check and this snapshot must
    // still be rejected, not accepted as a new public route to the cwd.
    for (const target of bindPaths) {
      for (const candidate of [normalizePathForPolicy(target), physical(target)]) {
        if (isWithinAuthorityPath(candidate, boundReadOnly.identity.path) ||
            isWithinAuthorityPath(boundReadOnly.identity.path, candidate) ||
            isWithinAuthorityPath(INHERITED_CWD_SANDBOX_PATH, candidate)) {
          throw new Error("narrow inherited cwd cannot retain an overlapping public read mount");
        }
      }
    }
    for (const target of boundReadOnly.explicitReadRoots) {
      if (target !== INHERITED_CWD_SANDBOX_PATH && physical(target) !== normalizePathForPolicy(target)) {
        throw new Error("narrow inherited cwd cannot retain an aliased read root");
      }
    }
  }
  const translated = translate(physical);
  const physicalCommandCwd = physical(commandCwd);
  const physicalProtectedTargets = protectedCreateTargets.map(physical);
  const scaffold: string[] = [];
  if (narrow) {
    for (const [location, alias] of snapshot.aliases) {
      appendParentDirs(scaffold, location);
      scaffold.push("--symlink", alias.target, location);
    }
  }
  assertFilesystemAliasesUnchanged(snapshot, captureFilesystemAliases(hostPaths, writablePaths));
  protectedCreateTargets.splice(0, protectedCreateTargets.length, ...physicalProtectedTargets);
  // Construct aliases in the private root before any host directory is bound.
  // Only empty directories and links are added, never access to their parents.
  return {
    args: narrow ? [...translated.slice(0, 2), ...scaffold, ...translated.slice(2)] : translated,
    commandCwd: physicalCommandCwd,
  };
}

function appendInheritedReadOnlyCwd(args: string[]): void {
  args.push("--dir", INHERITED_CWD_SANDBOX_PATH);
  args.push(
    "--ro-bind-fd",
    String(INHERITED_CWD_FD),
    INHERITED_CWD_SANDBOX_PATH,
  );
}

function appendWritableRoot(
  args: string[],
  root: WritableRoot,
  protectedCreateTargets: string[],
): void {
  appendBindIfExists(args, root.root);
  // Self-bind each writable ancestor before the read-only leaf. A mountpoint
  // cannot be renamed, so `mv home; mkdir home` cannot replace the trust root.
  // Apply these before the root's ordinary carve-outs, never over their masks.
  const canonicalRoot = canonicalAuthorityPath(root.root);
  const anchors = new Set<string>();
  for (const reserved of root.reservedReadOnlyPaths ?? []) {
    for (let ancestor = path.dirname(reserved);
      ancestor !== canonicalRoot && isWithinAuthorityPath(ancestor, canonicalRoot);
      ancestor = path.dirname(ancestor)) {
      if (!fs.existsSync(ancestor)) throw new Error(`cannot enforce missing reserved authority ancestor: ${ancestor}`);
      anchors.add(ancestor);
    }
  }
  for (const ancestor of [...anchors].sort((a, b) => a.length - b.length)) appendBindIfExists(args, ancestor);
  const handledProtectedNames = new Set<string>();
  for (const subpath of root.readOnlySubpaths) {
    if (fs.existsSync(subpath)) {
      rejectSymlinkCrossing(subpath, root.root, "read-only subpath");
      appendReadOnlyIfExists(args, subpath);
    } else {
      if (root.reservedReadOnlyPaths?.includes(subpath)) {
        appendReadOnlyEmptyDirectory(args, subpath);
        continue;
      }
      const protectedName = protectedMetadataNameForPath(root.root, subpath);
      if (protectedName !== null) {
        handledProtectedNames.add(protectedName);
        appendProtectedMissingMetadata(args, root.root, protectedName, protectedCreateTargets);
      } else {
        throw new Error(
          `cannot enforce missing read-only subpath inside Linux sandbox: ${subpath}`,
        );
      }
    }
  }
  for (const name of root.protectedMetadataNames ?? []) {
    if (!handledProtectedNames.has(name)) {
      appendProtectedMissingMetadata(args, root.root, name, protectedCreateTargets);
    }
  }
}

function appendBindIfExists(args: string[], source: string): void {
  if (!fs.existsSync(source)) return;
  appendParentDirs(args, source);
  args.push("--bind", source, source);
}

function appendReadOnlyIfExists(args: string[], source: string): void {
  if (!fs.existsSync(source)) return;
  appendParentDirs(args, source);
  args.push("--ro-bind", source, source);
}

function appendMask(
  args: string[],
  target: string,
  writableRoots: readonly WritableRoot[],
): void {
  for (const root of writableRoots) {
    rejectSymlinkCrossing(target, root.root, "unreadable path");
  }
  const writableRoot = writableRoots.find((root) => isWithinAuthorityPath(
    canonicalAuthorityPath(target), canonicalAuthorityPath(root.root),
  ));
  if (!fs.existsSync(target)) {
    if (writableRoot !== undefined) {
      appendReadOnlyEmptyDirectory(args, target);
    }
    return;
  }
  appendParentDirs(args, target);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    args.push("--tmpfs", target, "--remount-ro", target);
  } else {
    args.push("--ro-bind", "/dev/null", target);
  }
}

function appendReadOnlyEmptyDirectory(args: string[], target: string): void {
  appendParentDirs(args, target);
  args.push("--tmpfs", target, "--remount-ro", target);
}

function appendProtectedMissingMetadata(
  args: string[],
  root: string,
  name: string,
  protectedCreateTargets: string[],
): void {
  const target = path.join(root, name);
  if (fs.existsSync(target)) {
    rejectSymlinkCrossing(target, root, "protected metadata path");
    appendReadOnlyIfExists(args, target);
    return;
  }
  if (hasAncestorMetadata(root, name)) {
    protectedCreateTargets.push(target);
    return;
  }
  appendReadOnlyEmptyDirectory(args, target);
}

function appendParentDirs(args: string[], target: string): void {
  const normalized = normalizePathForPolicy(target);
  if (normalized === "/") return;
  const parts = normalized.split(path.sep).filter(Boolean);
  let current: string = path.sep;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index] ?? "");
    args.push("--dir", current);
  }
}

function expandUnreadableGlobMatches(
  patterns: readonly string[],
  cwd: string,
  maxDepth: number | undefined,
): string[] {
  if (patterns.length === 0) return [];
  const matches = new Set<string>();
  const specs = patterns.map((pattern) => ({
    matcher: globLikeMatcher(pattern),
    root: globSearchRoot(pattern, cwd),
  }));
  for (const spec of specs) {
    if (spec.root === path.parse(spec.root).root) {
      throw new Error(`unreadable glob expansion root is too broad: ${spec.root}`);
    }
    for (const candidate of walkExistingFiles(
      spec.root,
      maxDepth,
      MAX_UNREADABLE_GLOB_VISITS,
    )) {
      if (spec.matcher.test(candidate)) {
        matches.add(candidate);
        if (matches.size > MAX_UNREADABLE_GLOB_MATCHES) {
          throw new Error(
            `unreadable glob expansion exceeded ${MAX_UNREADABLE_GLOB_MATCHES} matches`,
          );
        }
      }
    }
  }
  return [...matches].sort();
}

function walkExistingFiles(
  root: string,
  maxDepth: number | undefined,
  maxVisits: number,
): string[] {
  const results: string[] = [];
  const stack: { readonly path: string; readonly depth: number }[] = [
    { path: root, depth: 0 },
  ];
  let visits = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) continue;
    visits += 1;
    if (visits > maxVisits) {
      throw new Error(
        `unreadable glob expansion exceeded ${maxVisits} scanned filesystem entries`,
      );
    }
    const current = item.path;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    results.push(current);
    if (maxDepth !== undefined && item.depth >= maxDepth) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      stack.push({ path: path.join(current, entry), depth: item.depth + 1 });
    }
  }
  return results;
}

function globLikeMatcher(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end !== -1) {
        source += globCharacterClass(pattern.slice(index + 1, end));
        index = end;
        continue;
      }
    }
    source += escapeRegexChar(char);
  }
  return new RegExp(`^${source}$`, "u");
}

function globCharacterClass(raw: string): string {
  if (raw.length === 0) return "\\[\\]";
  const negated = raw[0] === "!" || raw[0] === "^";
  const body = (negated ? raw.slice(1) : raw)
    .replace(/\\/gu, "\\\\")
    .replace(/-/gu, "\\-")
    .replace(/\]/gu, "\\]");
  return negated ? `[^/${body}]` : `[${body}]`;
}

function escapeRegexChar(char: string): string {
  return /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
}

function globSearchRoot(pattern: string, cwd: string): string {
  const absolutePattern = path.isAbsolute(pattern) ? pattern : path.resolve(cwd, pattern);
  const wildcardIndex = absolutePattern.search(/[*?[\]]/u);
  const staticPrefix = wildcardIndex === -1
    ? absolutePattern
    : absolutePattern.slice(0, wildcardIndex);
  const root = staticPrefix.endsWith(path.sep)
    ? staticPrefix.slice(0, -1)
    : path.dirname(staticPrefix);
  return root.length === 0 ? path.parse(absolutePattern).root : root;
}

function protectedMetadataNameForPath(root: string, target: string): string | null {
  const relative = path.relative(root, target);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  const [first, ...rest] = relative.split(path.sep);
  if (rest.length > 0) return null;
  return first === ".git" || first === ".agenc" || first === ".agents" ? first : null;
}

function hasAncestorMetadata(root: string, name: string): boolean {
  let current = path.dirname(normalizePathForPolicy(root));
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, name))) return true;
    current = path.dirname(current);
  }
  return fs.existsSync(path.join(current, name));
}

function rejectSymlinkCrossing(target: string, writableRoot: string, label: string): void {
  const normalizedTarget = normalizePathForPolicy(target);
  let normalizedRoot = normalizePathForPolicy(writableRoot);
  if (!pathStartsWith(normalizedTarget, normalizedRoot)) {
    const physicalRoot = canonicalAuthorityPath(writableRoot);
    let ancestor = path.dirname(normalizedTarget);
    while (canonicalAuthorityPath(ancestor) !== physicalRoot) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return;
      ancestor = parent;
    }
    // Keep the descendant spelling intact: resolving the target itself
    // would erase a hostile symlink below this authority boundary.
    normalizedRoot = ancestor;
  }
  const relative = path.relative(normalizedRoot, normalizedTarget);
  let current = normalizedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `cannot enforce ${label} crossing writable symlink: ${current}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("cannot enforce ")) {
        throw error;
      }
      return;
    }
  }
}
