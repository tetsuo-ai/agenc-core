/**
 * Filesystem case semantics for permission path matching.
 *
 * A path rule and the path it is checked against must agree on whether
 * `Secret.txt` and `SECRET.txt` name the same file. Default Windows and macOS
 * volumes say yes; Linux and case-sensitive APFS say no. Comparing with plain
 * JavaScript string operations answers "no" everywhere, so on a
 * case-insensitive volume a rule can miss the very file the OS opens.
 *
 * The answer comes from the volume holding the candidate path, not from the
 * platform alone: a mounted NTFS or SMB share on Linux ignores case, and a
 * case-sensitive APFS volume on macOS does not. The probe reads the directory
 * entry (it does not follow a symlink or treat a hard link as the same name).
 * Only ASCII letters are flipped, so a name like `ß.txt` is not looked up as
 * `SS.TXT`. A miss is not cached. A verdict from one volume is not applied to
 * a path that continues on another device.
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { normalizeCaseForComparison } from "./protected-paths.js";

export type PathCaseSemantics = "sensitive" | "insensitive";

type PathCaseSemanticsResolver = (path: string) => PathCaseSemantics;

type ProbeVerdict = {
  readonly semantics: PathCaseSemantics;
  readonly cacheable: boolean;
};

const MAX_CACHED_DIRECTORIES = 1024;

/** Semantics for entries directly inside a directory, keyed by its real path. */
const semanticsByDirectory = new Map<string, PathCaseSemantics>();

let resolverOverride: PathCaseSemanticsResolver | null = null;

/**
 * Case-insensitive volumes are the default on Windows and macOS; everything
 * else treats differently cased names as different files.
 */
export function platformDefaultPathCaseSemantics(): PathCaseSemantics {
  return process.platform === "win32" || process.platform === "darwin"
    ? "insensitive"
    : "sensitive";
}

function asciiLowerCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/** ASCII A-Z/a-z only. Unicode case folds such as `ß` → `SS` are not applied. */
function swapAsciiCase(name: string): string | null {
  let out = "";
  let changed = false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      out += String.fromCharCode(code + 32);
      changed = true;
      continue;
    }
    if (code >= 97 && code <= 122) {
      out += String.fromCharCode(code - 32);
      changed = true;
      continue;
    }
    out += name[i]!;
  }
  return changed ? out : null;
}

function asciiEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (asciiLowerCode(a.charCodeAt(i)) !== asciiLowerCode(b.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function realDirectory(directory: string): string {
  try {
    return realpathSync.native(directory);
  } catch {
    return directory;
  }
}

/**
 * Whether `entry`'s directory ignores case.
 *
 * Uses `lstat` and the directory listing. Two names that differ only by ASCII
 * case are case-sensitive even when one is a symlink or hard link to the
 * other. An `ENOENT` on the flipped spelling is a sensitive answer for this
 * call only and must not be cached.
 */
function probeEntry(entry: string): ProbeVerdict | null {
  const parent = dirname(entry);
  if (parent === entry) return null;
  const name = basename(entry);
  const flipped = swapAsciiCase(name);
  if (flipped === null) return null;

  let listed: string[];
  try {
    listed = readdirSync(parent);
  } catch {
    return null;
  }

  const twins = listed.filter((candidate) => asciiEqual(candidate, name));
  if (twins.length > 1) {
    return { semantics: "sensitive", cacheable: true };
  }

  try {
    lstatSync(entry);
  } catch {
    return null;
  }
  if (twins.length !== 1) return null;

  try {
    lstatSync(join(parent, flipped));
    return { semantics: "insensitive", cacheable: true };
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { semantics: "sensitive", cacheable: false };
    }
    return null;
  }
}

function remember(directory: string, semantics: PathCaseSemantics): void {
  const key = realDirectory(directory);
  if (semanticsByDirectory.size >= MAX_CACHED_DIRECTORIES) {
    semanticsByDirectory.clear();
  }
  semanticsByDirectory.set(key, semantics);
}

function cachedSemantics(directory: string): PathCaseSemantics | undefined {
  return semanticsByDirectory.get(realDirectory(directory));
}

/**
 * True when `dir` is a directory on a different device from its parent, so a
 * verdict about the parent must not be applied to names created inside `dir`.
 */
function isMountRoot(dir: string): boolean {
  const parent = dirname(dir);
  if (parent === dir) return false;
  try {
    const self = lstatSync(dir);
    const up = lstatSync(parent);
    return self.isDirectory() && self.dev !== up.dev;
  } catch {
    return false;
  }
}

/**
 * Case semantics of names inside `dir`, from a child that can be probed.
 * Null when the directory is missing or has no ASCII-letter name to flip.
 */
function semanticsInside(dir: string): PathCaseSemantics | null {
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch {
    return null;
  }
  const cached = semanticsByDirectory.get(real);
  if (cached !== undefined) return cached;

  let names: string[];
  try {
    names = readdirSync(real);
  } catch {
    return null;
  }
  for (const name of names) {
    if (swapAsciiCase(name) === null) continue;
    const probed = probeEntry(join(real, name));
    if (probed === null) continue;
    if (probed.cacheable) remember(real, probed.semantics);
    return probed.semantics;
  }
  return null;
}

/**
 * The case semantics governing `path` on the filesystem that holds it.
 *
 * Walks from the path towards the root until an existing entry can be probed.
 * A directory on another device stops the walk: the parent volume's verdict
 * does not describe names created inside that mount. ENOENT probes are not
 * cached.
 */
export function pathCaseSemantics(path: string): PathCaseSemantics {
  if (resolverOverride !== null) return resolverOverride(path);

  let current = path;
  while (true) {
    const directory = dirname(current);
    if (directory === current) return platformDefaultPathCaseSemantics();

    const cached = cachedSemantics(directory);
    if (cached !== undefined) return cached;

    const probed = probeEntry(current);
    if (probed !== null) {
      if (probed.cacheable) remember(directory, probed.semantics);
      return probed.semantics;
    }

    if (isMountRoot(directory)) return "sensitive";
    current = directory;
  }
}

/**
 * The form of a path used for comparison under an explicit `semantics`.
 * The original spelling stays what callers display and record.
 */
export function comparablePath(
  path: string,
  semantics: PathCaseSemantics,
): string {
  return semantics === "insensitive" ? normalizeCaseForComparison(path) : path;
}

/**
 * Comparison form of a real path: fold only segments whose parent directory
 * was probed case-insensitive. A segment on another device, or below a
 * directory that could not be probed, keeps its spelling.
 */
export function pathForComparison(path: string): string {
  if (resolverOverride !== null) {
    return comparablePath(path, resolverOverride(path));
  }

  const slash = path.replace(/\\/g, "/");
  const segments = slash.split("/");
  const useBackslash = path.includes("\\") && !path.includes("/");
  let built = "";
  let folded = "";
  let index = 0;

  if (slash.startsWith("/")) {
    built = "/";
    folded = "/";
    index = 1;
  } else if (/^[A-Za-z]:$/.test(segments[0] ?? "")) {
    const drive = segments[0]!;
    const foldDrive =
      semanticsInside(`${drive}/`) === "insensitive" ||
      semanticsInside(drive) === "insensitive";
    built = drive;
    folded = foldDrive ? normalizeCaseForComparison(drive) : drive;
    index = 1;
  }

  for (; index < segments.length; index++) {
    const segment = segments[index]!;
    if (segment === "") continue;
    const parent = built === "" ? "." : built;
    const fold = semanticsInside(parent) === "insensitive";
    const piece = fold ? normalizeCaseForComparison(segment) : segment;
    if (built === "/") {
      built = `/${segment}`;
      folded = `/${piece}`;
    } else if (built === "") {
      built = segment;
      folded = piece;
    } else {
      built = `${built}/${segment}`;
      folded = `${folded}/${piece}`;
    }
  }

  return useBackslash ? folded.replace(/\//g, "\\") : folded;
}

/**
 * Replace filesystem probing with a fixed answer so tests can exercise both
 * semantics on one host. Pass null to restore probing; the probe cache is
 * cleared either way.
 */
export function __setPathCaseSemanticsResolverForTesting(
  resolver: PathCaseSemanticsResolver | null,
): void {
  resolverOverride = resolver;
  semanticsByDirectory.clear();
}

/** How many directory verdicts are cached. ENOENT probes must not add one. */
export function __pathCaseSemanticsCacheSizeForTesting(): number {
  return semanticsByDirectory.size;
}
