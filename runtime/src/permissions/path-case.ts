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
 * case-sensitive APFS volume on macOS does not. The probe stats the nearest
 * existing entry under two spellings and compares file identity; when nothing
 * on the path can be probed the platform default applies.
 */

import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { normalizeCaseForComparison } from "./protected-paths.js";

export type PathCaseSemantics = "sensitive" | "insensitive";

type PathCaseSemanticsResolver = (path: string) => PathCaseSemantics;

const MAX_CACHED_DIRECTORIES = 1024;

/** Semantics for entries directly inside a directory, keyed by that directory. */
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

/**
 * The same name with every cased letter flipped, or null when the name has no
 * letter whose case can change (a drive root, `..`, digits only).
 */
function swapCase(name: string): string | null {
  let out = "";
  let changed = false;
  for (const char of name) {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if (lower === upper) {
      out += char;
      continue;
    }
    changed = true;
    out += char === lower ? upper : lower;
  }
  return changed ? out : null;
}

/**
 * Whether `entry`'s directory ignores case, judged by whether the entry is
 * reachable under a differently cased spelling and resolves to the same file.
 * Null when the entry does not exist or cannot answer the question.
 */
function probeEntry(entry: string): PathCaseSemantics | null {
  const parent = dirname(entry);
  if (parent === entry) return null;
  const flipped = swapCase(basename(entry));
  if (flipped === null) return null;

  let original: ReturnType<typeof statSync>;
  try {
    original = statSync(entry);
  } catch {
    return null;
  }

  try {
    const alternate = statSync(join(parent, flipped));
    return original.dev === alternate.dev && original.ino === alternate.ino
      ? "insensitive"
      : "sensitive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "sensitive" : null;
  }
}

function remember(directory: string, semantics: PathCaseSemantics): void {
  if (semanticsByDirectory.size >= MAX_CACHED_DIRECTORIES) {
    semanticsByDirectory.clear();
  }
  semanticsByDirectory.set(directory, semantics);
}

/**
 * The case semantics governing `path` on the filesystem that holds it.
 *
 * Walks from the path towards the root until an existing entry can be probed,
 * caching the verdict for the directory that contains it so siblings and the
 * files created under it later cost no further syscalls.
 */
export function pathCaseSemantics(path: string): PathCaseSemantics {
  if (resolverOverride !== null) return resolverOverride(path);

  let current = path;
  while (true) {
    const directory = dirname(current);
    const cached = semanticsByDirectory.get(directory);
    if (cached !== undefined) return cached;

    const probed = probeEntry(current);
    if (probed !== null) {
      remember(directory, probed);
      return probed;
    }

    if (directory === current) return platformDefaultPathCaseSemantics();
    current = directory;
  }
}

/**
 * The form of a path used for comparison under `semantics`. The original
 * spelling stays what callers display and record; only the comparison folds.
 */
export function comparablePath(
  path: string,
  semantics: PathCaseSemantics,
): string {
  return semantics === "insensitive" ? normalizeCaseForComparison(path) : path;
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
