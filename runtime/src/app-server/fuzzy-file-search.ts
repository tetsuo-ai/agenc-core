/**
 * Ports donor fuzzy file search request handling onto AgenC's daemon protocol.
 *
 * Source anchors:
 * - /home/tetsuo/git/codex/codex-rs/app-server/src/fuzzy_file_search.rs // branding-scan: allow donor source path
 * - /home/tetsuo/git/codex/codex-rs/file-search/src/lib.rs // branding-scan: allow donor source path
 *
 * Shape difference from upstream:
 *   - AgenC exposes the single-shot search as `fs.fuzzy_search` and keeps
 *     session streaming for a later notification/subscription row.
 */

import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import type {
  FuzzyFileSearchParams,
  FuzzyFileSearchResponse,
  FuzzyFileSearchResult,
} from "./protocol/index.js";

const MATCH_LIMIT = 50;
const MATCH_YIELD_INTERVAL = 256;
const SKIPPED_DIRECTORY_NAMES = new Set([".git"]);

const SCORE_MATCH = 16;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXTENSION = 1;
const BONUS_BOUNDARY = SCORE_MATCH / 2;
const BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1;
const BONUS_CAMEL123 = BONUS_BOUNDARY - PENALTY_GAP_START;
const BONUS_NON_WORD = BONUS_BOUNDARY;
const BONUS_CONSECUTIVE =
  PENALTY_GAP_START + PENALTY_GAP_EXTENSION;
const BONUS_FIRST_CHAR_MULTIPLIER = 2;

interface SearchEntry {
  readonly root: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly match_type: "file" | "directory";
}

interface SearchRoot {
  readonly displayRoot: string;
  readonly absoluteRoot: string;
  readonly ignoreContext: IgnoreContext;
}

interface IgnoreContext {
  readonly repoRoot: string | null;
  readonly ancestorMatchers: readonly IgnoreMatcher[];
}

interface IgnoreMatcher {
  readonly basePath: string;
  readonly matcher: ReturnType<typeof ignore>;
}

interface WalkFrame {
  readonly currentPath: string;
  readonly ignoreMatchers: readonly IgnoreMatcher[];
}

interface FuzzyMatch {
  readonly indices: readonly number[];
  readonly score: number;
}

type CharClass =
  | "whitespace"
  | "delimiter"
  | "nonWord"
  | "lower"
  | "upper"
  | "number";

export interface AgenCFuzzyFileSearch {
  search(
    params: FuzzyFileSearchParams,
    options?: AgenCFuzzyFileSearchSearchOptions,
  ): Promise<FuzzyFileSearchResponse>;
}

export type AgenCFuzzyFileSearchRunner = (
  params: FuzzyFileSearchParams,
  signal: AbortSignal,
) => Promise<readonly FuzzyFileSearchResult[]>;

export interface AgenCFuzzyFileSearchServiceOptions {
  readonly runSearch?: AgenCFuzzyFileSearchRunner;
}

export interface AgenCFuzzyFileSearchSearchOptions {
  readonly cancellationScope?: string;
  readonly signal?: AbortSignal;
}

export class AgenCFuzzyFileSearchService implements AgenCFuzzyFileSearch {
  readonly #pendingByToken = new Map<string, AbortController>();
  readonly #runSearch: AgenCFuzzyFileSearchRunner;

  constructor(options: AgenCFuzzyFileSearchServiceOptions = {}) {
    this.#runSearch = options.runSearch ?? runFuzzyFileSearch;
  }

  async search(
    params: FuzzyFileSearchParams,
    options: AgenCFuzzyFileSearchSearchOptions = {},
  ): Promise<FuzzyFileSearchResponse> {
    const cancellationToken = normalizedToken(params.cancellationToken);
    const cancellationKey =
      cancellationToken === null
        ? null
        : `${normalizedToken(options.cancellationScope) ?? "default"}\0${cancellationToken}`;
    const controller = new AbortController();
    const parentSignal = options.signal;
    const forwardParentAbort = (): void => {
      controller.abort(parentSignal?.reason ?? "request.cancel");
    };
    if (parentSignal?.aborted === true) {
      forwardParentAbort();
    } else {
      parentSignal?.addEventListener("abort", forwardParentAbort, { once: true });
    }
    if (cancellationKey !== null) {
      this.#pendingByToken.get(cancellationKey)?.abort();
      this.#pendingByToken.set(cancellationKey, controller);
    }
    try {
      if (params.query.length === 0 || params.roots.length === 0) {
        return { files: [] };
      }
      return {
        files: await this.#runSearch(params, controller.signal),
      };
    } finally {
      if (
        cancellationKey !== null &&
        this.#pendingByToken.get(cancellationKey) === controller
      ) {
        this.#pendingByToken.delete(cancellationKey);
      }
      parentSignal?.removeEventListener("abort", forwardParentAbort);
    }
  }
}

export async function runFuzzyFileSearch(
  params: FuzzyFileSearchParams,
  signal: AbortSignal = new AbortController().signal,
): Promise<readonly FuzzyFileSearchResult[]> {
  if (params.query.length === 0 || params.roots.length === 0) return [];
  const roots = await resolveSearchRoots(params.roots);
  const entries = await collectSearchEntriesForRoots(roots, signal);
  if (signal.aborted) return [];
  return await rankSearchEntries(params.query, entries, signal);
}

async function collectSearchEntriesForRoots(
  roots: readonly SearchRoot[],
  signal: AbortSignal,
): Promise<readonly SearchEntry[]> {
  const entries: SearchEntry[] = [];
  const seenPaths = new Set<string>();
  for (const root of roots) {
    if (signal.aborted) break;
    entries.push(...(await collectSearchEntries(root, signal, seenPaths)));
  }
  return entries;
}

async function rankSearchEntries(
  query: string,
  entries: readonly SearchEntry[],
  signal: AbortSignal,
): Promise<readonly FuzzyFileSearchResult[]> {
  const matches: FuzzyFileSearchResult[] = [];
  for (const [index, entry] of entries.entries()) {
    if (signal.aborted) return [];
    if (index > 0 && index % MATCH_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
      if (signal.aborted) return [];
    }
    const match = bestFuzzyMatch(entry.relativePath, query);
    if (match === null) continue;
    matches.push({
      root: entry.root,
      path: entry.relativePath,
      match_type: entry.match_type,
      file_name: basename(entry.relativePath) || entry.relativePath,
      score: match.score,
      indices: match.indices,
    });
  }
  if (signal.aborted) return [];
  matches.sort(compareByScoreDescThenPathAsc);
  return matches.slice(0, MATCH_LIMIT);
}

async function resolveSearchRoots(
  roots: readonly string[],
): Promise<readonly SearchRoot[]> {
  const searchRoots: SearchRoot[] = [];
  const seenAbsoluteRoots = new Set<string>();
  for (const root of roots) {
    const absoluteRoot = resolve(root);
    if (seenAbsoluteRoots.has(absoluteRoot)) continue;
    seenAbsoluteRoots.add(absoluteRoot);
    searchRoots.push({
      displayRoot: root,
      absoluteRoot,
      ignoreContext: await createIgnoreContext(absoluteRoot),
    });
  }
  searchRoots.sort(
    (left, right) =>
      pathDepth(right.absoluteRoot) - pathDepth(left.absoluteRoot) ||
      left.absoluteRoot.localeCompare(right.absoluteRoot),
  );
  return searchRoots;
}

async function collectSearchEntries(
  root: SearchRoot,
  signal: AbortSignal,
  seenPaths: Set<string>,
): Promise<readonly SearchEntry[]> {
  const entries: SearchEntry[] = [];
  const seenDirectories = new Set<string>();
  const stack: WalkFrame[] = [
    {
      currentPath: root.absoluteRoot,
      ignoreMatchers: root.ignoreContext.ancestorMatchers,
    },
  ];
  while (stack.length > 0) {
    if (signal.aborted) break;
    const frame = stack.pop()!;
    await visitSearchPath({
      root,
      frame,
      stack,
      entries,
      seenPaths,
      seenDirectories,
      signal,
    });
  }
  return entries;
}

async function visitSearchPath(params: {
  readonly root: SearchRoot;
  readonly frame: WalkFrame;
  readonly stack: WalkFrame[];
  readonly entries: SearchEntry[];
  readonly seenPaths: Set<string>;
  readonly seenDirectories: Set<string>;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (params.signal.aborted) return;
  const { currentPath, ignoreMatchers } = params.frame;
  let stat;
  try {
    stat = await lstat(currentPath);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    try {
      stat = await lstat(await realpath(currentPath));
    } catch {
      return;
    }
  }
  if (!stat.isDirectory() && !stat.isFile()) return;
  if (
    currentPath !== params.root.absoluteRoot &&
    SKIPPED_DIRECTORY_NAMES.has(basename(currentPath))
  ) {
    return;
  }
  if (isIgnored(ignoreMatchers, currentPath, stat.isDirectory())) {
    return;
  }
  const realEntryPath = await resolveRealPath(currentPath);
  if (params.seenPaths.has(realEntryPath)) return;
  params.seenPaths.add(realEntryPath);
  if (currentPath !== params.root.absoluteRoot) {
    const relativePath = toPortablePath(
      relative(params.root.absoluteRoot, currentPath),
    );
    if (relativePath.length > 0) {
      params.entries.push({
        root: params.root.displayRoot,
        absolutePath: currentPath,
        relativePath,
        match_type: stat.isDirectory() ? "directory" : "file",
      });
    }
  }
  if (!stat.isDirectory()) return;
  const realDirectory = realEntryPath;
  if (params.seenDirectories.has(realDirectory)) return;
  params.seenDirectories.add(realDirectory);
  let children;
  try {
    children = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }
  const childNames = new Set(children.map((child) => child.name));
  const childIgnoreMatchers = [
    ...ignoreMatchers,
    ...(await loadDirectoryIgnoreMatchers(
      params.root.ignoreContext,
      currentPath,
      childNames,
    )),
  ];
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children.reverse()) {
    if (params.signal.aborted) return;
    params.stack.push({
      ignoreMatchers: childIgnoreMatchers,
      currentPath: resolve(currentPath, child.name),
    });
  }
}

async function createIgnoreContext(absoluteRoot: string): Promise<IgnoreContext> {
  const repoRoot = await findRepoRoot(absoluteRoot);
  const matchers: IgnoreMatcher[] = [];
  if (repoRoot !== null) {
    matchers.push(...(await loadGitGlobalIgnoreMatchers(repoRoot)));
    const excludeMatcher = await loadGitInfoExcludeMatcher(repoRoot);
    if (excludeMatcher !== null) {
      matchers.push(excludeMatcher);
    }
  }
  for (const directory of pathAncestorsEndingAt(dirname(absoluteRoot))) {
    const localIgnoreMatcher = await readIgnoreFile(
      resolve(directory, ".ignore"),
      directory,
    );
    if (localIgnoreMatcher !== null) {
      matchers.push(localIgnoreMatcher);
    }
    if (repoRoot !== null && isWithinPath(repoRoot, directory)) {
      const gitIgnoreMatcher = await readIgnoreFile(
        resolve(directory, ".gitignore"),
        directory,
      );
      if (gitIgnoreMatcher !== null) {
        matchers.push(gitIgnoreMatcher);
      }
    }
  }
  return { repoRoot, ancestorMatchers: matchers };
}

async function findRepoRoot(startPath: string): Promise<string | null> {
  let currentPath = resolve(startPath);
  while (true) {
    try {
      const gitStat = await lstat(resolve(currentPath, ".git"));
      if (gitStat.isDirectory() || gitStat.isFile()) return currentPath;
    } catch {
      // Keep walking upward until there is no parent.
    }
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) return null;
    currentPath = parentPath;
  }
}

async function loadGitInfoExcludeMatcher(
  repoRoot: string,
): Promise<IgnoreMatcher | null> {
  const gitDir = await resolveGitDir(repoRoot);
  if (gitDir === null) return null;
  return await readIgnoreFile(resolve(gitDir, "info", "exclude"), repoRoot);
}

async function resolveGitDir(repoRoot: string): Promise<string | null> {
  const gitPath = resolve(repoRoot, ".git");
  let gitStat;
  try {
    gitStat = await lstat(gitPath);
  } catch {
    return null;
  }
  if (gitStat.isDirectory()) return gitPath;
  if (!gitStat.isFile()) return null;
  let gitFileText;
  try {
    gitFileText = await readFile(gitPath, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/imu.exec(gitFileText);
  if (match === null) return null;
  const gitDirPath = match[1]!.trim();
  return isAbsolute(gitDirPath) ? gitDirPath : resolve(repoRoot, gitDirPath);
}

async function loadGitGlobalIgnoreMatchers(
  repoRoot: string,
): Promise<readonly IgnoreMatcher[]> {
  const matchers: IgnoreMatcher[] = [];
  for (const ignoreFilePath of await gitGlobalIgnorePaths()) {
    const matcher = await readIgnoreFile(ignoreFilePath, repoRoot);
    if (matcher !== null) {
      matchers.push(matcher);
    }
  }
  return matchers;
}

async function gitGlobalIgnorePaths(): Promise<readonly string[]> {
  const paths: string[] = [];
  const configuredPath = await configuredGitGlobalIgnorePath();
  if (configuredPath !== null) {
    paths.push(configuredPath);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const home = process.env.HOME;
  if (xdgConfigHome !== undefined && xdgConfigHome.length > 0) {
    paths.push(resolve(xdgConfigHome, "git", "ignore"));
  } else if (home !== undefined && home.length > 0) {
    paths.push(resolve(home, ".config", "git", "ignore"));
  }
  return [...new Set(paths)];
}

async function configuredGitGlobalIgnorePath(): Promise<string | null> {
  const home = process.env.HOME;
  if (home === undefined || home.length === 0) return null;
  let gitconfigText;
  try {
    gitconfigText = await readFile(resolve(home, ".gitconfig"), "utf8");
  } catch {
    return null;
  }
  let inCoreSection = false;
  for (const rawLine of gitconfigText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch !== null) {
      inCoreSection = sectionMatch[1]!.trim().toLowerCase() === "core";
      continue;
    }
    if (!inCoreSection) continue;
    const settingMatch = /^excludesfile\s*=\s*(.+)$/iu.exec(line);
    if (settingMatch === null) continue;
    return expandGitConfigPath(settingMatch[1]!.trim(), home);
  }
  return null;
}

function expandGitConfigPath(value: string, home: string): string {
  const unquoted = value.replace(/^"(.*)"$/u, "$1");
  if (unquoted === "~") return home;
  if (unquoted.startsWith("~/")) return resolve(home, unquoted.slice(2));
  if (isAbsolute(unquoted)) return unquoted;
  return resolve(home, unquoted);
}

async function loadDirectoryIgnoreMatchers(
  ignoreContext: IgnoreContext,
  directory: string,
  childNames: ReadonlySet<string>,
): Promise<readonly IgnoreMatcher[]> {
  const matchers: IgnoreMatcher[] = [];
  if (childNames.has(".ignore")) {
    const localIgnoreMatcher = await readIgnoreFile(
      resolve(directory, ".ignore"),
      directory,
    );
    if (localIgnoreMatcher !== null) {
      matchers.push(localIgnoreMatcher);
    }
  }
  if (
    ignoreContext.repoRoot !== null &&
    isWithinPath(ignoreContext.repoRoot, directory) &&
    childNames.has(".gitignore")
  ) {
    const gitIgnoreMatcher = await readIgnoreFile(
      resolve(directory, ".gitignore"),
      directory,
    );
    if (gitIgnoreMatcher !== null) {
      matchers.push(gitIgnoreMatcher);
    }
  }
  return matchers;
}

async function readIgnoreFile(
  ignoreFilePath: string,
  basePath: string,
): Promise<IgnoreMatcher | null> {
  let ignoreText;
  try {
    ignoreText = await readFile(ignoreFilePath, "utf8");
  } catch {
    return null;
  }
  return {
    basePath,
    matcher: ignore().add(ignoreText.split(/\r?\n/)),
  };
}

function isIgnored(
  ignoreMatchers: readonly IgnoreMatcher[],
  absolutePath: string,
  isDirectory: boolean,
): boolean {
  let ignored = false;
  for (const ignoreMatcher of ignoreMatchers) {
    const relativePath = toPortablePath(
      relative(ignoreMatcher.basePath, absolutePath),
    );
    if (!isRelativePathInsideBase(relativePath)) continue;
    const gitignorePath = isDirectory ? `${relativePath}/` : relativePath;
    const result = ignoreMatcher.matcher.test(gitignorePath);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

async function resolveRealPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function pathDepth(path: string): number {
  return toPortablePath(resolve(path)).split("/").filter(Boolean).length;
}

function pathAncestorsEndingAt(path: string): readonly string[] {
  const ancestors: string[] = [];
  let currentPath = resolve(path);
  while (true) {
    ancestors.push(currentPath);
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }
  ancestors.reverse();
  return ancestors;
}

function isWithinPath(basePath: string, candidatePath: string): boolean {
  const relativePath = toPortablePath(
    relative(resolve(basePath), resolve(candidatePath)),
  );
  return relativePath.length === 0 || isRelativePathInsideBase(relativePath);
}

function isRelativePathInsideBase(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !relativePath.startsWith("/")
  );
}

function bestFuzzyMatch(relativePath: string, query: string): FuzzyMatch | null {
  const pathMatch = nucleoPathMatch(relativePath, query);
  const fileName = basename(relativePath) || relativePath;
  const nameMatch = nucleoPathMatch(fileName, query);
  if (nameMatch === null) return pathMatch;
  const prefix = relativePath.slice(0, relativePath.length - fileName.length);
  const offset = Array.from(prefix).length;
  const adjustedNameMatch: FuzzyMatch = {
    score: nameMatch.score,
    indices: nameMatch.indices.map((index) => index + offset),
  };
  if (pathMatch === null) return adjustedNameMatch;
  return adjustedNameMatch.score > pathMatch.score
    ? adjustedNameMatch
    : pathMatch;
}

function nucleoPathMatch(haystack: string, needle: string): FuzzyMatch | null {
  if (needle.length === 0) {
    return { indices: [], score: 0 };
  }
  const loweredHaystackText = haystack.toLowerCase();
  const loweredNeedleText = needle.toLowerCase();
  for (const char of new Set(Array.from(loweredNeedleText))) {
    if (!loweredHaystackText.includes(char)) return null;
  }
  const haystackChars = Array.from(haystack);
  const needleChars = Array.from(loweredNeedleText);
  if (needleChars.length > haystackChars.length) return null;
  const normalizedHaystack = haystackChars.map((char) => char.toLowerCase());
  const charClasses = haystackChars.map(charClassFor);
  const memo = new Map<string, { readonly score: number; readonly indices: number[] } | null>();

  const bestTail = (
    lastIndex: number,
    needleIndex: number,
    firstBonus: number,
  ): { readonly score: number; readonly indices: number[] } | null => {
    if (needleIndex >= needleChars.length) {
      return { score: 0, indices: [] };
    }
    const key = `${lastIndex}:${needleIndex}:${firstBonus}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    let best: { readonly score: number; readonly indices: number[] } | null =
      null;
    const remaining = needleChars.length - needleIndex - 1;
    for (
      let index = lastIndex + 1;
      index < haystackChars.length - remaining;
      index += 1
    ) {
      if (normalizedHaystack[index] !== needleChars[needleIndex]) continue;
      const gap = index - lastIndex - 1;
      const penalty =
        gap === 0 ? 0 : PENALTY_GAP_START + (gap - 1) * PENALTY_GAP_EXTENSION;
      const previousClass =
        gap === 0 ? charClasses[lastIndex]! : charClasses[index - 1]!;
      const className = charClasses[index]!;
      let bonus = bonusFor(previousClass, className);
      let nextFirstBonus = firstBonus;
      if (gap === 0) {
        if (bonus >= BONUS_BOUNDARY && bonus > nextFirstBonus) {
          nextFirstBonus = bonus;
        }
        bonus = Math.max(bonus, nextFirstBonus, BONUS_CONSECUTIVE);
      } else {
        nextFirstBonus = bonus;
      }
      const tail = bestTail(index, needleIndex + 1, nextFirstBonus);
      if (tail === null) continue;
      const score = SCORE_MATCH + bonus - penalty + tail.score;
      if (best === null || score > best.score) {
        best = { score, indices: [index, ...tail.indices] };
      }
    }
    memo.set(key, best);
    return best;
  };

  let best: { readonly score: number; readonly indices: number[] } | null = null;
  const remaining = needleChars.length - 1;
  for (let index = 0; index < haystackChars.length - remaining; index += 1) {
    if (normalizedHaystack[index] !== needleChars[0]) continue;
    const previousClass =
      index === 0 ? "delimiter" : charClasses[index - 1]!;
    const className = charClasses[index]!;
    const firstBonus = bonusFor(previousClass, className);
    const tail = bestTail(index, 1, firstBonus);
    if (tail === null) continue;
    const score =
      SCORE_MATCH +
      firstBonus * BONUS_FIRST_CHAR_MULTIPLIER +
      tail.score;
    if (best === null || score > best.score) {
      best = { score, indices: [index, ...tail.indices] };
    }
  }
  if (best === null) return null;
  return {
    indices: [...new Set(best.indices)].sort((left, right) => left - right),
    score: best.score,
  };
}

function bonusFor(prevClass: CharClass, className: CharClass): number {
  if (isWordClass(className)) {
    if (prevClass === "whitespace") return BONUS_BOUNDARY;
    if (prevClass === "delimiter") return BONUS_BOUNDARY_DELIMITER;
    if (prevClass === "nonWord") return BONUS_BOUNDARY;
  }
  if (
    (prevClass === "lower" && className === "upper") ||
    (prevClass !== "number" && className === "number")
  ) {
    return BONUS_CAMEL123;
  }
  if (className === "whitespace") return BONUS_BOUNDARY;
  if (className === "nonWord") return BONUS_NON_WORD;
  return 0;
}

function isWordClass(className: CharClass): boolean {
  return (
    className === "lower" ||
    className === "upper" ||
    className === "number"
  );
}

function charClassFor(char: string): CharClass {
  if (/^\s$/u.test(char)) return "whitespace";
  if (char === "/" || char === "\\") return "delimiter";
  if (/^[0-9]$/u.test(char)) return "number";
  if (/^[a-z]$/u.test(char)) return "lower";
  if (/^[A-Z]$/u.test(char)) return "upper";
  if (/^\p{L}$/u.test(char)) {
    return char === char.toUpperCase() && char !== char.toLowerCase()
      ? "upper"
      : "lower";
  }
  return "nonWord";
}

function compareByScoreDescThenPathAsc(
  left: FuzzyFileSearchResult,
  right: FuzzyFileSearchResult,
): number {
  const score = right.score - left.score;
  if (score !== 0) return score;
  return left.path.localeCompare(right.path);
}

function toPortablePath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function normalizedToken(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveYield) => {
    setImmediate(resolveYield);
  });
}
