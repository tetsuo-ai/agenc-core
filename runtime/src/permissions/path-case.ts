/**
 * Filesystem case semantics for permission path matching.
 *
 * A path rule and the path it is checked against must agree on whether
 * `Secret.txt` and `SECRET.txt` name the same file. Default Windows and macOS
 * volumes say yes; Linux and case-sensitive APFS say no. Comparing with plain
 * JavaScript string operations answers "no" everywhere, so on a
 * case-insensitive volume a rule can miss the very file the OS opens.
 *
 * The answer comes from the volume holding each directory, not from the
 * platform alone. The probe reads the directory entry (it does not follow a
 * symlink or treat a hard link as the same name) and flips ASCII letters
 * only, so `ß.txt` is not looked up as `SS.TXT`. A name that does not exist
 * yet inherits the nearest existing directory. A directory on another device
 * does not inherit its parent. The platform default applies only when no
 * existing directory on the path can be probed.
 */

import { lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

import { normalizeCaseForComparison } from "./protected-paths.js";

export type PathCaseSemantics = "sensitive" | "insensitive";

type PathCaseSemanticsResolver = (path: string) => PathCaseSemantics;

type DirectorySemanticsOverride = (
  directory: string,
) => PathCaseSemantics | undefined;

type ProbeVerdict = {
  readonly semantics: PathCaseSemantics;
  readonly cacheable: boolean;
};

type ComparisonOrigin = {
  readonly built: string;
  readonly folded: string;
  readonly index: number;
  readonly verdict: PathCaseSemantics;
};

const ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz";
const MAX_CACHED_DIRECTORIES = 1024;

/** Semantics for entries directly inside a directory, keyed by its real path. */
const semanticsByDirectory = new Map<string, PathCaseSemantics>();

type EntryStats = {
  readonly dev: Stats["dev"];
  readonly ino: Stats["ino"];
  isDirectory(): boolean;
};

let resolverOverride: PathCaseSemanticsResolver | null = null;
let directoryOverride: DirectorySemanticsOverride | null = null;
let lstatEntry: (path: string) => EntryStats = lstatSync;
let readDirectory: (path: string) => string[] = readdirSync;

/**
 * Case-insensitive volumes are the default on Windows and macOS; everything
 * else treats differently cased names as different files.
 */
export function platformDefaultPathCaseSemantics(): PathCaseSemantics {
  return process.platform === "win32" || process.platform === "darwin"
    ? "insensitive"
    : "sensitive";
}

/** ASCII A-Z/a-z only. Unicode case folds such as `ß` → `SS` are not applied. */
export function __swapAsciiCaseForTesting(name: string): string | null {
  return swapAsciiCase(name);
}

function swapAsciiCase(name: string): string | null {
  let out = "";
  let changed = false;
  for (const char of name) {
    const upperIndex = ASCII_UPPER.indexOf(char);
    if (upperIndex !== -1) {
      out += ASCII_LOWER.charAt(upperIndex);
      changed = true;
      continue;
    }
    const lowerIndex = ASCII_LOWER.indexOf(char);
    if (lowerIndex !== -1) {
      out += ASCII_UPPER.charAt(lowerIndex);
      changed = true;
      continue;
    }
    out += char;
  }
  return changed ? out : null;
}

function asciiFoldChar(char: string): string {
  const upperIndex = ASCII_UPPER.indexOf(char);
  return upperIndex === -1 ? char : ASCII_LOWER.charAt(upperIndex);
}

function asciiEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (asciiFoldChar(a.charAt(i)) !== asciiFoldChar(b.charAt(i))) return false;
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
 * other. A flipped spelling that is missing is cached only when this entry
 * itself exists and is the only ASCII-case twin in the listing, so a Unicode
 * expansion such as `ß` → `SS` cannot poison the directory.
 */
function probeEntry(entry: string): ProbeVerdict | null {
  const parent = dirname(entry);
  if (parent === entry) return null;
  const name = basename(entry);
  const flipped = swapAsciiCase(name);
  if (flipped === null) return null;

  let listed: string[];
  try {
    listed = readDirectory(parent);
  } catch {
    return null;
  }

  const twins = listed.filter((candidate) => asciiEqual(candidate, name));
  if (twins.length > 1) {
    return { semantics: "sensitive", cacheable: true };
  }

  let original: EntryStats;
  try {
    original = lstatEntry(entry);
  } catch {
    return null;
  }
  if (twins.length !== 1) return null;

  try {
    const alternate = lstatEntry(join(parent, flipped));
    if (alternate.dev === original.dev && alternate.ino === original.ino) {
      return { semantics: "insensitive", cacheable: true };
    }
    return verdictForDistinctInode(parent, name, flipped);
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return sensitiveIfStillPresent(entry, original);
    }
    return null;
  }
}

/**
 * A different dev/ino on the flipped spelling is sensitive only when both
 * names are actually in the listing. Filesystems that invent an inode per
 * lookup (SMB `noserverino`) must not be cached as sensitive, or a deny
 * misses the recased name.
 */
function verdictForDistinctInode(
  parent: string,
  name: string,
  flipped: string,
): ProbeVerdict {
  let listed: string[];
  try {
    listed = readDirectory(parent);
  } catch {
    return { semantics: "insensitive", cacheable: false };
  }
  const bothListed = listed.includes(name) && listed.includes(flipped);
  return bothListed
    ? { semantics: "sensitive", cacheable: true }
    : { semantics: "insensitive", cacheable: false };
}

function sensitiveIfStillPresent(entry: string, original: EntryStats): ProbeVerdict {
  try {
    const again = lstatEntry(entry);
    const stillThere = again.dev === original.dev && again.ino === original.ino;
    return { semantics: "sensitive", cacheable: stillThere };
  } catch {
    return { semantics: "sensitive", cacheable: false };
  }
}

function remember(directory: string, semantics: PathCaseSemantics): void {
  const key = realDirectory(directory);
  if (semanticsByDirectory.size >= MAX_CACHED_DIRECTORIES) {
    semanticsByDirectory.clear();
  }
  semanticsByDirectory.set(key, semantics);
}

/**
 * True when `dir` is a directory on a different device from its parent, so a
 * verdict about the parent must not be applied to names created inside `dir`.
 */
function isMountRoot(dir: string): boolean {
  const parent = dirname(dir);
  if (parent === dir) return false;
  try {
    const self = lstatEntry(dir);
    const up = lstatEntry(parent);
    return self.isDirectory() && self.dev !== up.dev;
  } catch {
    return false;
  }
}

function isExistingDirectory(dir: string): boolean {
  try {
    return lstatEntry(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Case semantics of names inside `dir`, from a child that can be probed.
 * Null when the directory is missing or has no ASCII-letter name to flip.
 */
function semanticsInside(dir: string): PathCaseSemantics | null {
  if (directoryOverride !== null) {
    const forced = directoryOverride(dir);
    if (forced !== undefined) return forced;
  }

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
    names = readDirectory(real);
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
 * Verdict for names inside `parent`. A missing parent keeps `inherited`. An
 * existing directory on another device that cannot be probed is sensitive, so
 * it does not inherit an insensitive parent volume.
 */
function verdictForParent(
  parent: string,
  inherited: PathCaseSemantics,
): PathCaseSemantics {
  const probed = semanticsInside(parent);
  if (probed !== null) return probed;
  if (isExistingDirectory(parent) && isMountRoot(parent)) return "sensitive";
  return inherited;
}

function driveSemantics(
  drive: string,
  inherited: PathCaseSemantics,
): PathCaseSemantics {
  return (
    semanticsInside(`${drive}/`) ?? semanticsInside(drive) ?? inherited
  );
}

export type ComparisonRootKind = "unc" | "absolute" | "drive" | "relative";

export type ParsedComparisonPath = {
  readonly kind: ComparisonRootKind;
  readonly root: string;
  readonly segments: readonly string[];
};

/**
 * Split a path into the directory root and the segments under it.
 * On Windows a UNC path keeps `//server/share`. Everywhere else a leading
 * `//` collapses the way normal path normalization does.
 */
export function parseComparisonRoot(
  path: string,
  platform: NodeJS.Platform = process.platform,
): ParsedComparisonPath {
  const slash = path.replaceAll("\\", "/");
  if (platform === "win32" && slash.startsWith("//")) return parseUncRoot(slash);
  const collapsed = slash.replaceAll(/\/{2,}/g, "/");
  if (collapsed.startsWith("/")) {
    return {
      kind: "absolute",
      root: "/",
      segments: collapsed.split("/").slice(1).filter((segment) => segment !== ""),
    };
  }
  const collapsedSegments = collapsed.split("/");
  const collapsedDrive = collapsedSegments[0] ?? "";
  if (/^[A-Za-z]:$/.test(collapsedDrive)) {
    return {
      kind: "drive",
      root: collapsedDrive,
      segments: collapsedSegments.slice(1).filter((segment) => segment !== ""),
    };
  }
  return {
    kind: "relative",
    root: "",
    segments: collapsedSegments.filter((segment) => segment !== ""),
  };
}

function parseUncRoot(slash: string): ParsedComparisonPath {
  const body = slash.split("/").filter((segment) => segment !== "");
  const server = body[0] ?? "";
  const share = body[1] ?? "";
  const root = share === "" ? `//${server}` : `//${server}/${share}`;
  return {
    kind: "unc",
    root,
    segments: share === "" ? body.slice(1) : body.slice(2),
  };
}

function comparisonOrigin(
  slash: string,
  segments: readonly string[],
): ComparisonOrigin {
  const inherited = platformDefaultPathCaseSemantics();
  if (process.platform === "win32" && slash.startsWith("//")) {
    const unc = parseUncRoot(slash);
    const verdict = semanticsInside(unc.root) ?? inherited;
    return {
      built: unc.root,
      folded: foldSegment(unc.root, verdict),
      index: segments.length - unc.segments.length,
      verdict,
    };
  }
  if (slash.startsWith("/")) {
    return { built: "/", folded: "/", index: 1, verdict: inherited };
  }
  const drive = segments[0] ?? "";
  if (/^[A-Za-z]:$/.test(drive)) {
    const verdict = driveSemantics(drive, inherited);
    return {
      built: drive,
      folded: verdict === "insensitive" ? normalizeCaseForComparison(drive) : drive,
      index: 1,
      verdict,
    };
  }
  return { built: "", folded: "", index: 0, verdict: inherited };
}

function appendSegment(parent: string, segment: string): string {
  if (parent === "/") return `/${segment}`;
  if (parent === "") return segment;
  return `${parent}/${segment}`;
}

function isWildcardSegment(segment: string): boolean {
  return (
    segment.includes("*") ||
    segment.includes("?") ||
    segment.includes("[") ||
    segment.includes("{")
  );
}

function foldSegment(segment: string, verdict: PathCaseSemantics): string {
  return verdict === "insensitive" ? normalizeCaseForComparison(segment) : segment;
}

function joinUnderRoot(root: string, segments: readonly string[]): string {
  const body = segments.join("/");
  if (body === "") return root === "" ? "" : root;
  if (root === "" ) return body;
  if (root === "/") return `/${body}`;
  return `${root}/${body}`;
}

/** How much of a wildcard tail may fold. */
export type WildcardTailFold = "narrow" | "wide";

/**
 * Directories that govern the wildcard tail, starting at the directory that
 * contains the first wildcard segment (the root, for an unanchored pattern)
 * and continuing through the file's parent.
 */
function tailDirectoryPaths(candidateSlash: string, wildcardAt: number): readonly string[] {
  const parsed = parseComparisonRoot(candidateSlash);
  const lastDirectory = parsed.segments.length - 1;
  const paths: string[] = [];
  for (let index = wildcardAt - 1; index < lastDirectory; index++) {
    paths.push(
      index < 0
        ? parsed.root
        : joinUnderRoot(parsed.root, parsed.segments.slice(0, index + 1)),
    );
  }
  return paths;
}

function semanticsOfDirectory(dir: string): PathCaseSemantics {
  if (dir === "" || dir === "/") return pathCaseSemantics("/x");
  const inside = dir.endsWith("/") ? `${dir}x` : `${dir}/x`;
  return pathCaseSemantics(inside);
}

function foldTail(tail: WildcardTailFold, verdicts: readonly PathCaseSemantics[]): boolean {
  switch (tail) {
    case "wide":
      return verdicts.length === 0 || verdicts.some((verdict) => verdict === "insensitive");
    case "narrow":
      return verdicts.length > 0 && verdicts.every((verdict) => verdict === "insensitive");
    default: {
      const unreachable: never = tail;
      return unreachable;
    }
  }
}

/**
 * Verdict for the wildcard tail.
 * `narrow` (allow) folds only when every directory from the one holding the
 * first wildcard segment through the file's parent is case-insensitive.
 * `wide` (deny and ask) folds when any of those directories is
 * case-insensitive, so a block is not missed in either mixed layout.
 */
function wildcardTailVerdict(
  candidateSlash: string,
  wildcardAt: number,
  tail: WildcardTailFold,
): PathCaseSemantics {
  const verdicts = tailDirectoryPaths(candidateSlash, wildcardAt).map(semanticsOfDirectory);
  return foldTail(tail, verdicts) ? "insensitive" : "sensitive";
}

/**
 * Fold a rule for comparison against `candidateSlash`.
 * Concrete segments before the first wildcard use the rule path's own
 * directories. The wildcard and everything after it use `tail`. A rule
 * with no concrete directory (unanchored) has an empty prefix, so every
 * candidate directory counts. Neither mode uses `process.cwd()`.
 */
export function foldRuleForCandidate(
  ruleSlash: string,
  candidateSlash: string,
  tail: WildcardTailFold = "wide",
): string {
  const parsed = parseComparisonRoot(ruleSlash);
  const wildcardAt = parsed.segments.findIndex((segment) => isWildcardSegment(segment));
  if (wildcardAt === -1) return pathForComparison(ruleSlash);
  const verdict = wildcardTailVerdict(candidateSlash, wildcardAt, tail);
  const remainder = parsed.segments
    .slice(wildcardAt)
    .map((segment) => foldSegment(segment, verdict))
    .join("/");
  if (wildcardAt === 0 && parsed.kind === "relative") return remainder;
  const prefix = joinUnderRoot(parsed.root, parsed.segments.slice(0, wildcardAt));
  const foldedPrefix = pathForComparison(prefix);
  if (remainder === "") return foldedPrefix;
  if (foldedPrefix === "/" || foldedPrefix === "") {
    return foldedPrefix === "/" ? `/${remainder}` : remainder;
  }
  return `${foldedPrefix}/${remainder}`;
}

function walkComparison(
  slash: string,
  segments: readonly string[],
): { readonly folded: string; readonly verdict: PathCaseSemantics } {
  const origin = comparisonOrigin(slash, segments);
  let built = origin.built;
  let folded = origin.folded;
  let inherited = origin.verdict;
  let afterWildcard = false;

  for (let index = origin.index; index < segments.length; index++) {
    const segment = segments[index]!;
    if (segment === "") continue;
    const parent = built === "" ? "." : built;
    const verdict = afterWildcard ? inherited : verdictForParent(parent, inherited);
    if (!afterWildcard) inherited = verdict;
    folded = appendSegment(folded, foldSegment(segment, verdict));
    built = appendSegment(built, segment);
    if (isWildcardSegment(segment)) afterWildcard = true;
  }
  return { folded, verdict: inherited };
}

/**
 * The case semantics governing the last segment of `path`.
 *
 * Missing segments inherit the nearest existing directory. A mount whose
 * device differs from its parent does not inherit that parent. Tests still
 * call this; production comparison uses `pathForComparison`, which applies
 * the same per-directory verdict.
 */
export function pathCaseSemantics(path: string): PathCaseSemantics {
  if (resolverOverride !== null) return resolverOverride(path);
  const slash = path.replaceAll("\\", "/");
  return walkComparison(slash, slash.split("/")).verdict;
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
 * Comparison form of a path. Each concrete directory is probed on its own
 * device. Segments that do not exist yet, and segments after a wildcard,
 * inherit the last concrete verdict (or the platform default when nothing
 * on the path can be probed).
 */
export function pathForComparison(path: string): string {
  if (resolverOverride !== null) {
    return comparablePath(path, resolverOverride(path));
  }
  const slash = path.replaceAll("\\", "/");
  const folded = walkComparison(slash, slash.split("/")).folded;
  if (path.includes("\\") && !path.includes("/")) {
    return folded.replaceAll("/", "\\");
  }
  return folded;
}

/**
 * Replace filesystem probing with a fixed answer so tests can exercise both
 * semantics on one host. Pass null to restore probing; the probe cache is
 * cleared either way. This folds the whole path and clears a per-directory
 * override.
 */
export function __setPathCaseSemanticsResolverForTesting(
  resolver: PathCaseSemanticsResolver | null,
): void {
  resolverOverride = resolver;
  if (resolver !== null) directoryOverride = null;
  semanticsByDirectory.clear();
}

/**
 * Force the case semantics of specific directories. A directory the function
 * does not answer is probed on disk. Missing descendants inherit the nearest
 * answered ancestor. Pass null to restore probing.
 */
/**
 * Replace `lstat` inside the probe. Pass null to restore the real call.
 * Used to simulate a file disappearing between the two spellings.
 */
export function __setPathCaseLstatForTesting(
  impl: ((path: string) => EntryStats) | null,
): void {
  lstatEntry = impl ?? lstatSync;
  semanticsByDirectory.clear();
}

/** Replace `readdir` inside the probe. Pass null to restore the real call. */
export function __setPathCaseReaddirForTesting(
  impl: ((path: string) => string[]) | null,
): void {
  readDirectory = impl ?? readdirSync;
  semanticsByDirectory.clear();
}

export function __setPathCaseDirectorySemanticsForTesting(
  resolver: DirectorySemanticsOverride | null,
): void {
  directoryOverride = resolver;
  if (resolver !== null) resolverOverride = null;
  semanticsByDirectory.clear();
}

/** How many directory verdicts are cached. */
export function __pathCaseSemanticsCacheSizeForTesting(): number {
  return semanticsByDirectory.size;
}

/** Whether `directory` itself has a cached verdict. */
export function __pathCaseDirectoryCachedForTesting(directory: string): boolean {
  return semanticsByDirectory.has(realDirectory(directory));
}
