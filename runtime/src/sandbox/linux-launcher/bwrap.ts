import fs from "node:fs";
import path from "node:path";

import {
  hasFullDiskReadAccess,
  hasFullDiskWriteAccess,
  getReadableRootsWithCwd,
  getUnreadableGlobsWithCwd,
  getUnreadableRootsWithCwd,
  getWritableRootsWithCwd,
  includePlatformDefaults,
  normalizePathForPolicy,
  pathStartsWith,
  type FileSystemSandboxPolicy,
  type WritableRoot,
} from "../engine/index.js";

export type BwrapNetworkMode = "full-access" | "isolated" | "proxy-only";

export interface BwrapOptions {
  readonly mountProc: boolean;
  readonly networkMode: BwrapNetworkMode;
  readonly seccompFd?: number;
  readonly extraBindRoots?: readonly string[];
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
  return { args, usesBubblewrap: true, protectedCreateTargets };
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
    "--unshare-user",
    "--unshare-pid",
  ];
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
  const args = [
    "--new-session",
    "--die-with-parent",
    ...createFilesystemArgs(
      fileSystemSandboxPolicy,
      sandboxPolicyCwd,
      options,
      protectedCreateTargets,
    ),
    "--unshare-user",
    "--unshare-pid",
  ];
  appendNamespaceArgs(args, options);
  const normalizedCommandCwd = normalizeExistingPath(commandCwd);
  if (normalizedCommandCwd !== normalizePathForPolicy(commandCwd)) {
    args.push("--chdir", normalizedCommandCwd);
  }
  args.push("--");
  args.push(...command);
  return args;
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
  options: BwrapOptions,
  protectedCreateTargets: string[],
): string[] {
  const args: string[] = [];
  const writableRoots = getWritableRootsWithCwd(policy, sandboxPolicyCwd);
  if (hasFullDiskReadAccess(policy)) {
    args.push("--ro-bind", "/", "/");
  } else {
    args.push("--tmpfs", "/");
    if (includePlatformDefaults(policy)) {
      appendReadOnlyIfExists(args, "/bin");
      appendReadOnlyIfExists(args, "/lib");
      appendReadOnlyIfExists(args, "/lib64");
      appendReadOnlyIfExists(args, "/usr");
      appendReadOnlyIfExists(args, "/etc");
    }
    for (const root of getReadableRootsWithCwd(policy, sandboxPolicyCwd)) {
      appendReadOnlyIfExists(args, root);
    }
  }

  args.push("--dev", "/dev");

  for (const root of writableRoots) {
    appendWritableRoot(args, root, protectedCreateTargets);
  }
  for (const root of options.extraBindRoots ?? []) {
    appendBindIfExists(args, root);
  }
  for (const root of getUnreadableRootsWithCwd(policy, sandboxPolicyCwd)) {
    appendMask(args, root, writableRoots);
  }
  for (const root of expandUnreadableGlobMatches(
    getUnreadableGlobsWithCwd(policy, sandboxPolicyCwd),
    sandboxPolicyCwd,
    policy.globScanMaxDepth,
  )) {
    appendMask(args, root, writableRoots);
  }
  return args;
}

function appendWritableRoot(
  args: string[],
  root: WritableRoot,
  protectedCreateTargets: string[],
): void {
  appendBindIfExists(args, root.root);
  const handledProtectedNames = new Set<string>();
  for (const subpath of root.readOnlySubpaths) {
    if (fs.existsSync(subpath)) {
      rejectSymlinkCrossing(subpath, root.root, "read-only subpath");
      appendReadOnlyIfExists(args, subpath);
    } else {
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
  const writableRoot = writableRoots.find((root) => pathStartsWith(target, root.root));
  if (!fs.existsSync(target)) {
    if (writableRoot !== undefined) {
      appendReadOnlyEmptyDirectory(args, target);
    }
    return;
  }
  if (writableRoot !== undefined) {
    rejectSymlinkCrossing(target, writableRoot.root, "unreadable path");
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
  const normalizedRoot = normalizePathForPolicy(writableRoot);
  if (!pathStartsWith(normalizedTarget, normalizedRoot)) return;
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

function normalizeExistingPath(target: string): string {
  try {
    return normalizePathForPolicy(fs.realpathSync(target));
  } catch {
    return normalizePathForPolicy(target);
  }
}
