/**
 * Memory loader — assembles `MEMORY.md` + ordered topic files into a
 * bounded prompt fragment the runtime injects as system-context.
 *
 * Hand-port of openclaude `memdir/memdir.ts` load path (line 272-316
 * `buildMemoryPrompt` subset). Differs:
 *   - Async from the start: runtime is async-first, no sync-reads.
 *   - Line AND byte caps (TODO.MD §T10-C: 200 lines / 25KB).
 *   - Lock registry (`memoryWriteLocks`) lives here — every writer
 *     (auto-save, manual edit, CLI) shares the same `AsyncLock<void>`
 *     keyed by absolute file path to satisfy I-29.
 *
 * The loader does NOT write. Writers import {@link getMemoryWriteLock}
 * and wrap their mutation in `.with()`. Keeping the lock registry
 * next to the reader keeps readers/writers on the same module and
 * avoids a third file just for a single Map.
 *
 * @module
 */

import { readTextFile } from "../_deps/file-read.js";
import { AsyncLock } from "../_deps/async-lock.js";
import { scanMemoryIndex } from "./scan.js";
import { parseFrontmatter, type MemoryEntry } from "./types.js";
import { withFsLock, type FsLockOpts } from "./fs-lock.js";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { memoryLayout } from "./layout.js";

/** Default line cap for the assembled memory prompt. */
export const DEFAULT_MEMORY_MAX_LINES = 200;

/** Default byte cap for the assembled memory prompt. */
export const DEFAULT_MEMORY_MAX_BYTES = 25_000;

export interface LoadMemoryOpts {
  /** Absolute path to the memory directory (parent of MEMORY.md). */
  readonly memoryDir: string;
  /** Absolute path to the `MEMORY.md` index file. */
  readonly memoryMdPath: string;
  /** Line cap. Default 200. */
  readonly maxLines?: number;
  /** Byte cap. Default 25 000. */
  readonly maxBytes?: number;
}

export interface LoadedMemory {
  /** Concatenated text ready to splice into the system prompt. */
  readonly text: string;
  /** Ordered list of loaded memory entries. */
  readonly entries: readonly MemoryEntry[];
  /** True when either cap fired. */
  readonly truncated: boolean;
  /** Line count of the final `text`. */
  readonly lineCount: number;
  /** Byte count of the final `text`. */
  readonly byteCount: number;
}

/**
 * Load `MEMORY.md` and the topic files it points to, concatenated
 * into a single prompt fragment. Stops appending when either cap
 * trips. Missing index or empty dir returns a zero-byte result.
 */
export async function loadMemoryPrompt(
  opts: LoadMemoryOpts,
): Promise<LoadedMemory> {
  const maxLines = opts.maxLines ?? DEFAULT_MEMORY_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;

  const layout = memoryLayout(opts.memoryDir);

  // Read the v2 summary first when present. This is the bounded
  // navigation layer; MEMORY.md remains the searchable handbook/index.
  let summaryText = "";
  try {
    summaryText = await readTextFile(layout.memorySummaryPath);
  } catch {
    summaryText = "";
  }

  // Read the index after the summary — this is the ordered pointer list.
  let indexText = "";
  try {
    indexText = await readTextFile(opts.memoryMdPath);
  } catch {
    indexText = "";
  }

  if (summaryText.trim().length === 0 && indexText.trim().length === 0) {
    return {
      text: "",
      entries: [],
      truncated: false,
      lineCount: 0,
      byteCount: 0,
    };
  }

  const indexPaths = await scanMemoryIndex(opts.memoryMdPath);
  const entries: MemoryEntry[] = [];

  let accumulated = "";
  let lineCount = 0;
  let byteCount = 0;
  let truncated = false;

  // Precise line accounting: count actual newline characters. `split("\n")`
  // over-counts by one per chunk (and chunks ending in `\n\n` look like
  // three pieces, not one real line), which fires the maxLines cap
  // earlier than intended.
  const countNewlines = (chunk: string): number =>
    chunk === "" ? 0 : chunk.match(/\n/g)?.length ?? 0;

  const appendChunk = (chunk: string): boolean => {
    const chunkLines = countNewlines(chunk);
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (
      lineCount + chunkLines > maxLines ||
      byteCount + chunkBytes > maxBytes
    ) {
      truncated = true;
      return false;
    }
    accumulated += chunk;
    lineCount += chunkLines;
    byteCount += chunkBytes;
    return true;
  };

  if (summaryText.trim().length > 0) {
    const header = `# memory_summary.md\n${summaryText.replace(/\n+$/, "")}\n\n`;
    if (!appendChunk(header)) {
      const available = Math.max(0, maxBytes - byteCount);
      if (available > 0) {
        const sliced = header.slice(0, available);
        const cutAt = sliced.lastIndexOf("\n");
        const safe = cutAt > 0 ? sliced.slice(0, cutAt) : sliced;
        accumulated += safe;
        lineCount += countNewlines(safe);
        byteCount += Buffer.byteLength(safe, "utf8");
      }
      return {
        text: accumulated,
        entries,
        truncated: true,
        lineCount,
        byteCount,
      };
    }
  }

  // Then include the handbook/index itself.
  if (indexText.trim().length > 0) {
    const header = `# MEMORY.md\n${indexText.replace(/\n+$/, "")}\n\n`;
    if (!appendChunk(header)) {
      // Even the index overflows — truncate it to fit.
      const available = Math.max(0, maxBytes - byteCount);
      if (available > 0) {
        const sliced = header.slice(0, available);
        const cutAt = sliced.lastIndexOf("\n");
        const safe = cutAt > 0 ? sliced.slice(0, cutAt) : sliced;
        accumulated += safe;
        lineCount += countNewlines(safe);
        byteCount += Buffer.byteLength(safe, "utf8");
      }
      return {
        text: accumulated,
        entries,
        truncated: true,
        lineCount,
        byteCount,
      };
    }
  }

  // Now append each referenced topic file in order.
  for (const path of indexPaths) {
    let raw: string;
    let mtimeMs = 0;
    try {
      raw = await readTextFile(path);
      const stats = await stat(path);
      mtimeMs = stats.mtimeMs;
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (parsed === null) continue;
    const entry: MemoryEntry = {
      filePath: path,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      mtimeMs,
      byteLength: Buffer.byteLength(raw, "utf8"),
    };
    const chunk = `## ${parsed.frontmatter.name ?? path}\n${parsed.body}\n\n`;
    if (!appendChunk(chunk)) break;
    entries.push(entry);
  }

  return {
    text: accumulated,
    entries,
    truncated,
    lineCount,
    byteCount,
  };
}

// ─────────────────────────────────────────────────────────────────────
// I-29 — memory file write lock registry
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-path write lock returned by {@link getMemoryWriteLock}. Composes
 * an in-process `AsyncLock<void>` (cheap intra-process serialization)
 * with a cross-process `withFsLock` exclusive lockfile (I-29 Fix-F).
 *
 * Callers treat this as a mutex with the same `with()` surface as
 * `AsyncLock`. The AsyncLock is the outer gate so same-process writers
 * never open competing `<path>.lock` files against themselves.
 */
export interface MemoryWriteLock {
  /**
   * Run `fn` with exclusive access to the file. `opts` tunes the
   * cross-process acquisition (timeout, retry interval); defaults are
   * the 2s / 50ms values from the I-29 spec.
   */
  with<T>(fn: () => Promise<T>, opts?: FsLockOpts): Promise<T>;
  /**
   * Test-only escape hatch for suites that want to exercise the outer
   * AsyncLock directly without touching the filesystem lockfile.
   */
  readonly _inner: AsyncLock<void>;
}

/**
 * Per-path write-lock registry. Auto-extract (async subagent) and
 * manual edits (CLI, /memory add) acquire the same `MemoryWriteLock`
 * for the exact file path they are about to write, so interleaved
 * writers cannot corrupt a memory file or the MEMORY.md index.
 *
 * The registry is module-global and persists for the life of the
 * runtime process — an AsyncLock has no resources to release, and
 * stale entries cost a single Map slot each. No eviction needed.
 */
const memoryWriteLocks = new Map<string, MemoryWriteLock>();

/**
 * Obtain the canonical write lock for `absolutePath`. All writers
 * for the same path receive the same lock instance — that is the
 * whole point. Callers should use the lock's `.with()` method.
 *
 * Paths are normalized via `path.resolve` before lookup so that
 * equivalent-but-differently-spelled inputs (e.g. `/a/b/../b/x.md`
 * vs `/a/b/x.md`) resolve to the same lock and cannot race. Symlinks
 * are not resolved — if you need `realpath` equivalence, call it at
 * the call site and pass the canonical result in.
 *
 * I-29 Fix-F: the returned lock wraps every `with()` call in an
 * `fs.open(path.lock, 'wx')` cross-process critical section with a
 * 2s default timeout and 50ms retry cadence. The AsyncLock remains
 * the outer gate so intra-process writers never contend on the
 * lockfile against themselves.
 */
export function getMemoryWriteLock(absolutePath: string): MemoryWriteLock {
  const key = resolvePath(absolutePath);
  const existing = memoryWriteLocks.get(key);
  if (existing !== undefined) return existing;

  const inner = new AsyncLock<void>(undefined);
  const lock: MemoryWriteLock = {
    async with<T>(fn: () => Promise<T>, opts?: FsLockOpts): Promise<T> {
      return inner.with(() => withFsLock(key, fn, opts));
    },
    _inner: inner,
  };
  memoryWriteLocks.set(key, lock);
  return lock;
}

/**
 * Snapshot of locks held in the registry. Test-only helper — the
 * registry is expected to grow monotonically in production.
 */
export function _memoryWriteLocksForTest(): ReadonlyMap<
  string,
  MemoryWriteLock
> {
  return memoryWriteLocks;
}

/** Clear the lock registry. Test-only. */
export function _clearMemoryWriteLocksForTest(): void {
  memoryWriteLocks.clear();
}
