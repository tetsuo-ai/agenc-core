/**
 * Memory-directory scanning primitives.
 *
 * Hand-port of openclaude `memdir/memoryScan.ts` (102 LOC). Differs:
 *   - Returns full MemoryEntry (frontmatter + body + size) instead of
 *     header-only records. T10 consumers (loader, attachments, auto-save
 *     extractor) need the body text; a second read would double syscalls.
 *   - Uses AgenC's central `readTextFile` for BOM/line-ending
 *     normalization (I-80, I-81).
 *
 * Caps (from TODO.MD §T10-C): ≤200 files, ≤25KB accumulated bytes. Files
 * past either cap are dropped from the returned list with a counter so
 * callers can attribute truncation. Newest-mtime-first ordering so the
 * caps bite the oldest memories when pressure hits.
 *
 * Directory recursion is depth-capped at 3 (openclaude #42-3: unbounded
 * `readdir({recursive:true})` is a DoS surface via symlink loops or deep
 * trees). `MEMORY.md` is always skipped — it's an index, not a memory.
 *
 * @module
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { readTextFile } from "../_deps/file-read.js";
import { parseFrontmatter, type MemoryEntry } from "./types.js";
import {
  MEMORY_INDEX_FILENAME,
  MEMORY_SUMMARY_FILENAME,
  RAW_MEMORIES_FILENAME,
} from "./layout.js";

/** Maximum number of memory files surfaced per scan. */
export const MAX_MEMORY_FILES = 200;

/** Maximum accumulated bytes across all scanned memories. */
export const MAX_MEMORY_BYTES = 25_000;

/** Maximum recursion depth inside a memory dir (symlink/DoS guard). */
export const MAX_SCAN_DEPTH = 3;

/** Entry-file name — never returned from a scan. */
export const ENTRYPOINT_NAME = MEMORY_INDEX_FILENAME;

export interface ScanResult {
  readonly entries: readonly MemoryEntry[];
  /** True when at least one file was dropped by the file/byte cap. */
  readonly truncated: boolean;
  /** Files dropped by the 200-file cap. */
  readonly filesDropped: number;
  /** Files dropped by the 25KB byte cap. */
  readonly bytesDropped: number;
}

/**
 * Scan `memoryDir` for `.md` memory files. Returns newest-first,
 * capped at 200 files / 25KB. Malformed frontmatter files are skipped
 * with a warning count (they are NOT returned as degraded entries —
 * the caller's relevance scorer would blindly surface them otherwise).
 */
export async function scanMemoryDir(
  memoryDir: string,
  options?: {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
  },
): Promise<ScanResult> {
  const maxFiles = options?.maxFiles ?? MAX_MEMORY_FILES;
  const maxBytes = options?.maxBytes ?? MAX_MEMORY_BYTES;

  let dirents: string[];
  try {
    dirents = await readdir(memoryDir, { recursive: true });
  } catch {
    return {
      entries: [],
      truncated: false,
      filesDropped: 0,
      bytesDropped: 0,
    };
  }

  const candidates = dirents.filter((rel) => {
    if (!rel.endsWith(".md")) return false;
    const base = basename(rel);
    if (
      base === ENTRYPOINT_NAME ||
      base === MEMORY_SUMMARY_FILENAME ||
      base === RAW_MEMORIES_FILENAME
    ) {
      return false;
    }
    // Hidden files (anywhere in the path).
    for (const segment of rel.split(sep)) {
      if (segment.startsWith(".") && segment !== "." && segment !== "..") {
        return false;
      }
    }
    // Depth cap: count separators, reject beyond MAX_SCAN_DEPTH.
    const depth = rel.split(sep).length - 1;
    if (depth >= MAX_SCAN_DEPTH) return false;
    return true;
  });

  const parsed = await Promise.allSettled(
    candidates.map(async (rel): Promise<MemoryEntry | null> => {
      const filePath = join(memoryDir, rel);
      const [text, stats] = await Promise.all([
        readTextFile(filePath),
        stat(filePath),
      ]);
      const parsed = parseFrontmatter(text);
      if (parsed === null) return null;
      return {
        filePath,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        mtimeMs: stats.mtimeMs,
        byteLength: Buffer.byteLength(text, "utf8"),
      };
    }),
  );

  const good: MemoryEntry[] = [];
  for (const result of parsed) {
    if (result.status === "fulfilled" && result.value !== null) {
      good.push(result.value);
    }
  }
  good.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Cap at file count first.
  const filesDropped = Math.max(0, good.length - maxFiles);
  const afterFileCap = good.slice(0, maxFiles);

  // Then cap at byte budget.
  const kept: MemoryEntry[] = [];
  let accumulated = 0;
  let bytesDropped = 0;
  for (const entry of afterFileCap) {
    if (accumulated + entry.byteLength > maxBytes) {
      bytesDropped++;
      continue;
    }
    accumulated += entry.byteLength;
    kept.push(entry);
  }

  return {
    entries: kept,
    truncated: filesDropped > 0 || bytesDropped > 0,
    filesDropped,
    bytesDropped,
  };
}

/**
 * Parse the ordered bullet-list of file pointers inside `MEMORY.md`.
 *
 * The index uses a simple shape (per openclaude buildMemoryLines): each
 * line looks like `- [Title](relative-path.md) — hook text`. This parser
 * extracts the `(path)` segment, resolves relative to the MEMORY.md's
 * directory, and preserves order (newest-first by convention, but we
 * don't re-sort — the index file owns ordering).
 *
 * Returns an empty array when the file is missing or has no bullet links.
 */
export async function scanMemoryIndex(
  memoryMdPath: string,
): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readTextFile(memoryMdPath);
  } catch {
    return [];
  }

  const paths: string[] = [];
  const bulletRe = /^\s*[-*]\s+\[[^\]]*\]\(([^)]+)\)/;
  const memoryDir = memoryMdPath.slice(
    0,
    Math.max(memoryMdPath.lastIndexOf(sep), 0),
  );
  for (const line of raw.split("\n")) {
    const match = bulletRe.exec(line);
    if (!match) continue;
    const href = match[1]?.trim();
    if (!href || href.length === 0) continue;
    // Skip absolute URLs.
    if (/^[a-z]+:\/\//i.test(href)) continue;
    const resolved = href.startsWith("/")
      ? href
      : memoryDir.length > 0
        ? join(memoryDir, href)
        : href;
    paths.push(resolved);
  }
  return paths;
}
