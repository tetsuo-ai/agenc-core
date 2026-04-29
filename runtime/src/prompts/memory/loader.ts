/**
 * Memory loader — emits a bounded memory-policy prompt fragment.
 *
 * Detailed memory content is intentionally NOT injected here. The
 * upstream contract uses the memory prompt as policy/discovery context
 * and surfaces detailed memory files through the per-turn relevant
 * memory attachment producer. Keeping this loader content-free prevents
 * stale `MEMORY.md` task indexes from being interpreted as active work
 * after `/clear`.
 *
 * Differs:
 *   - Async from the start: runtime is async-first, no sync-reads.
 *   - Line AND byte caps (TODO.MD §T10-C: 200 lines / 25KB), applied
 *     to the small policy fragment.
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
import type { MemoryEntry } from "./types.js";
import { withFsLock, type FsLockOpts } from "./fs-lock.js";
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
  /** Detailed entries loaded into the base prompt. Intentionally empty. */
  readonly entries: readonly MemoryEntry[];
  /** True when either cap fired. */
  readonly truncated: boolean;
  /** Line count of the final `text`. */
  readonly lineCount: number;
  /** Byte count of the final `text`. */
  readonly byteCount: number;
}

/**
 * Load memory policy for the system prompt. `MEMORY.md`,
 * `memory_summary.md`, and detailed topic files remain durable
 * retrieval inputs, but their content is not injected here. Missing
 * memory files return a zero-byte result.
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

  const appendTruncatedChunk = (chunk: string): void => {
    let remainingLines = Math.max(0, maxLines - lineCount);
    let remainingBytes = Math.max(0, maxBytes - byteCount);
    if (remainingLines === 0 || remainingBytes === 0) return;

    let safe = "";
    // Split after newlines so line accounting stays exact.
    const pieces = chunk.match(/[^\n]*\n|[^\n]+/g) ?? [];
    for (const piece of pieces) {
      const pieceLines = countNewlines(piece);
      const pieceBytes = Buffer.byteLength(piece, "utf8");
      if (pieceLines > remainingLines || pieceBytes > remainingBytes) break;
      safe += piece;
      remainingLines -= pieceLines;
      remainingBytes -= pieceBytes;
    }
    if (safe.length === 0 && remainingBytes > 0) {
      const sliced = chunk.slice(0, remainingBytes);
      const cutAt = sliced.lastIndexOf("\n");
      safe = cutAt > 0 ? sliced.slice(0, cutAt) : sliced;
    }
    accumulated += safe;
    lineCount += countNewlines(safe);
    byteCount += Buffer.byteLength(safe, "utf8");
  };

  const policy = [
    "# Memory",
    "",
    `AgenC has durable memory available at ${opts.memoryDir}. Relevant memories are surfaced as per-turn attachments when they clearly match the user's request.`,
    "",
    "Do not treat memory as active task state. Memory may be stale; verify file, function, flag, and current-status claims against the workspace before acting on them.",
    "",
    "`MEMORY.md` and `memory_summary.md` are retrieval indexes. Their contents are not injected into this base prompt.",
    "",
  ].join("\n");

  if (!appendChunk(policy)) {
    appendTruncatedChunk(policy);
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
