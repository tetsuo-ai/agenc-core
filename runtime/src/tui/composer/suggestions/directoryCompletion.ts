/**
 * `@<path>` directory and file completion source.
 *
 * Ported from upstream. Upstream uses `lru-cache` for the directory
 * scan cache; this port uses a small TTL-keyed Map cache to avoid
 * pulling in an extra dependency. The cache size is bounded by
 * `CACHE_SIZE` and entries are evicted on a simple FIFO trim.
 *
 * Outputs `SuggestionItem`s consumed by
 * `composer/PromptInputFooterSuggestions`. AgenC's `Palette` widget
 * has its own `@`-mention walker (`palette-sources::getMentionItems`);
 * use this module when wiring the inline ghost-completion footer
 * surface instead of the popover.
 */
import { promises as fs } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import type { SuggestionItem } from "../PromptInputFooterSuggestions.js";

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "directory";
}

export interface PathEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "directory" | "file";
}

export interface CompletionOptions {
  readonly basePath?: string;
  readonly maxResults?: number;
}

export interface PathCompletionOptions extends CompletionOptions {
  readonly includeFiles?: boolean;
  readonly includeHidden?: boolean;
}

interface ParsedPath {
  readonly directory: string;
  readonly prefix: string;
}

const CACHE_SIZE = 500;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<V> {
  readonly value: V;
  readonly expires: number;
}

class TtlCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.max) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  }

  clear(): void {
    this.entries.clear();
  }
}

const directoryCache = new TtlCache<readonly DirectoryEntry[]>(CACHE_SIZE);
const pathCache = new TtlCache<readonly PathEntry[]>(CACHE_SIZE);

/** Cheap equivalent of upstream's `getCwd()` — `process.cwd()`. */
function getCwd(): string {
  return process.cwd();
}

/**
 * Expand `~`-prefixed paths to the user's home directory. Anything
 * else is left to `path.resolve` semantics on the caller side.
 */
function expandPath(input: string, basePath?: string): string {
  if (input === "~") return process.env.HOME ?? input;
  if (input.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    return home ? join(home, input.slice(2)) : input;
  }
  if (input.startsWith("/")) return input;
  return join(basePath ?? getCwd(), input);
}

export function parsePartialPath(
  partialPath: string,
  basePath?: string,
): ParsedPath {
  if (!partialPath) {
    const directory = basePath || getCwd();
    return { directory, prefix: "" };
  }

  const resolved = expandPath(partialPath, basePath);

  if (partialPath.endsWith("/") || partialPath.endsWith(sep)) {
    return { directory: resolved, prefix: "" };
  }

  return {
    directory: dirname(resolved),
    prefix: basename(partialPath),
  };
}

/**
 * Scan `dirPath` for subdirectories. Hidden directories (`.`-prefixed)
 * are filtered out and the result is bounded to 100 entries to keep
 * large repos from freezing the suggestion footer.
 */
export async function scanDirectory(
  dirPath: string,
): Promise<readonly DirectoryEntry[]> {
  const cached = directoryCache.get(dirPath);
  if (cached) return cached;

  let directories: readonly DirectoryEntry[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        type: "directory" as const,
      }))
      .slice(0, 100);
  } catch {
    directories = [];
  }

  directoryCache.set(dirPath, directories);
  return directories;
}

export async function getDirectoryCompletions(
  partialPath: string,
  options: CompletionOptions = {},
): Promise<SuggestionItem[]> {
  const { basePath = getCwd(), maxResults = 10 } = options;

  const { directory, prefix } = parsePartialPath(partialPath, basePath);
  const entries = await scanDirectory(directory);
  const prefixLower = prefix.toLowerCase();
  const matches = entries
    .filter((entry) => entry.name.toLowerCase().startsWith(prefixLower))
    .slice(0, maxResults);

  return matches.map((entry) => ({
    id: entry.path,
    displayText: entry.name + "/",
    description: "directory",
    metadata: { type: "directory" as const },
  }));
}

export function clearDirectoryCache(): void {
  directoryCache.clear();
}

export function isPathLikeToken(token: string): boolean {
  return (
    token.startsWith("~/") ||
    token.startsWith("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token === "~" ||
    token === "." ||
    token === ".."
  );
}

/**
 * Scan `dirPath` for both files and subdirectories. Directories are
 * sorted ahead of files; alphabetical within each group.
 */
export async function scanDirectoryForPaths(
  dirPath: string,
  includeHidden = false,
): Promise<readonly PathEntry[]> {
  const cacheKey = `${dirPath}:${includeHidden ? "1" : "0"}`;
  const cached = pathCache.get(cacheKey);
  if (cached) return cached;

  let paths: readonly PathEntry[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    paths = entries
      .filter((entry) => includeHidden || !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        type: entry.isDirectory()
          ? ("directory" as const)
          : ("file" as const),
      }))
      .sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 100);
  } catch {
    paths = [];
  }

  pathCache.set(cacheKey, paths);
  return paths;
}

export async function getPathCompletions(
  partialPath: string,
  options: PathCompletionOptions = {},
): Promise<SuggestionItem[]> {
  const {
    basePath = getCwd(),
    maxResults = 10,
    includeFiles = true,
    includeHidden = false,
  } = options;

  const { directory, prefix } = parsePartialPath(partialPath, basePath);
  const entries = await scanDirectoryForPaths(directory, includeHidden);
  const prefixLower = prefix.toLowerCase();

  const matches = entries
    .filter((entry) => {
      if (!includeFiles && entry.type === "file") return false;
      return entry.name.toLowerCase().startsWith(prefixLower);
    })
    .slice(0, maxResults);

  const hasSeparator =
    partialPath.includes("/") || partialPath.includes(sep);
  let dirPortion = "";
  if (hasSeparator) {
    const lastSlash = partialPath.lastIndexOf("/");
    const lastSep = partialPath.lastIndexOf(sep);
    const lastSeparatorPos = Math.max(lastSlash, lastSep);
    dirPortion = partialPath.substring(0, lastSeparatorPos + 1);
  }
  if (dirPortion.startsWith("./") || dirPortion.startsWith("." + sep)) {
    dirPortion = dirPortion.slice(2);
  }

  return matches.map((entry) => {
    const fullPath = dirPortion + entry.name;
    return {
      id: fullPath,
      displayText: entry.type === "directory" ? fullPath + "/" : fullPath,
      metadata: { type: entry.type },
    };
  });
}

export function clearPathCache(): void {
  directoryCache.clear();
  pathCache.clear();
}
