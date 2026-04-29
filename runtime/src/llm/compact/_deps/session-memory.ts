/**
 * Session-memory subsystem the compact path consumes.
 *
 * Ported from upstream openclaude's
 * `src/services/SessionMemory/sessionMemoryUtils.ts` and
 * `src/services/SessionMemory/prompts.ts`, adapted to the gut runtime:
 *
 * - Storage roots in `${AGENC_HOME}/memory/` (default: `$HOME/.agenc/memory/`).
 *   `MEMORY.md` holds the session-memory note file consumed by the compact
 *   prompt assembler. `last-summarized.json` holds the persisted
 *   `lastSummarizedMessageId` so a resumed session can re-anchor compact
 *   without re-extraction.
 * - `waitForSessionMemoryExtraction()` honours an in-process extraction
 *   gate (started/completed signals) with the same 15s wait + 1m staleness
 *   semantics as upstream. The gut runtime does not yet drive this gate
 *   from a forked-agent extractor, but the surface is real so any future
 *   producer can call `markExtractionStarted/Completed` and the compact
 *   path will block correctly.
 * - `getSessionMemoryPath()` matches the legacy gut path so existing
 *   tests and rollout-context paths keep resolving.
 *
 * No AgenC SessionMemory module is imported.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EXTRACTION_WAIT_TIMEOUT_MS = 15_000;
const EXTRACTION_STALE_THRESHOLD_MS = 60_000; // 1 minute
const EXTRACTION_POLL_INTERVAL_MS = 250;

const MAX_SECTION_LENGTH = 2000;

const SESSION_MEMORY_FILE = "MEMORY.md";
const LAST_SUMMARIZED_FILE = "last-summarized.json";

const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function memoryDir(): string {
  if (process.env.AGENC_MEMORY_DIR) return process.env.AGENC_MEMORY_DIR;
  const home =
    process.env.AGENC_HOME ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agenc");
  return join(home, "memory");
}

export function getSessionMemoryPath(): string {
  return join(memoryDir(), SESSION_MEMORY_FILE);
}

function getLastSummarizedPath(): string {
  return join(memoryDir(), LAST_SUMMARIZED_FILE);
}

function isFsMissing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// ---------------------------------------------------------------------------
// In-process extraction gate
// ---------------------------------------------------------------------------

let extractionStartedAt: number | undefined;

export function markExtractionStarted(): void {
  extractionStartedAt = Date.now();
}

export function markExtractionCompleted(): void {
  extractionStartedAt = undefined;
}

/**
 * Block until any in-flight session-memory extraction completes, with the
 * same 15s wait ceiling and 1-minute staleness short-circuit as upstream.
 */
export async function waitForSessionMemoryExtraction(): Promise<void> {
  const startTime = Date.now();
  while (extractionStartedAt !== undefined) {
    const extractionAge = Date.now() - extractionStartedAt;
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) {
      // Stale extraction — don't wait, treat as abandoned.
      return;
    }
    if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) {
      // Hard timeout — continue without holding up compact.
      return;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, EXTRACTION_POLL_INTERVAL_MS),
    );
  }
}

// ---------------------------------------------------------------------------
// Session-memory file content
// ---------------------------------------------------------------------------

/**
 * Read the session-memory note file. Returns null when the file does not
 * exist (no extraction has produced one yet) or the path is inaccessible.
 */
export async function getSessionMemoryContent(): Promise<string | null> {
  const path = getSessionMemoryPath();
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isFsMissing(err)) return null;
    throw err;
  }
}

/**
 * Match upstream's empty check: the note file is "empty" when its contents
 * are exactly the unmodified template (no real extraction has happened).
 */
export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  if (!content || content.trim().length === 0) return true;
  return content.trim() === DEFAULT_SESSION_MEMORY_TEMPLATE.trim();
}

/**
 * Truncate per-section content to the upstream MAX_SECTION_LENGTH char
 * budget so a runaway section can't consume the entire post-compact
 * token window. Preserves section headers verbatim.
 *
 * Field names match upstream: `truncatedContent` / `wasTruncated`.
 */
export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string;
  wasTruncated: boolean;
} {
  const lines = content.split("\n");
  const maxCharsPerSection = MAX_SECTION_LENGTH * 4; // ~tokens *4 chars
  const outputLines: string[] = [];
  let currentSectionLines: string[] = [];
  let currentSectionHeader = "";
  let wasTruncated = false;

  for (const line of lines) {
    if (line.startsWith("# ")) {
      const result = flushSessionSection(
        currentSectionHeader,
        currentSectionLines,
        maxCharsPerSection,
      );
      outputLines.push(...result.lines);
      wasTruncated = wasTruncated || result.wasTruncated;
      currentSectionHeader = line;
      currentSectionLines = [];
    } else {
      currentSectionLines.push(line);
    }
  }

  const tail = flushSessionSection(
    currentSectionHeader,
    currentSectionLines,
    maxCharsPerSection,
  );
  outputLines.push(...tail.lines);
  wasTruncated = wasTruncated || tail.wasTruncated;

  return {
    truncatedContent: outputLines.join("\n"),
    wasTruncated,
  };
}

function flushSessionSection(
  sectionHeader: string,
  sectionLines: string[],
  maxCharsPerSection: number,
): { lines: string[]; wasTruncated: boolean } {
  if (!sectionHeader) {
    return { lines: sectionLines, wasTruncated: false };
  }
  const sectionContent = sectionLines.join("\n");
  if (sectionContent.length <= maxCharsPerSection) {
    return { lines: [sectionHeader, ...sectionLines], wasTruncated: false };
  }
  let charCount = 0;
  const keptLines: string[] = [sectionHeader];
  for (const line of sectionLines) {
    if (charCount + line.length + 1 > maxCharsPerSection) break;
    keptLines.push(line);
    charCount += line.length + 1;
  }
  keptLines.push("\n[... section truncated for length ...]");
  return { lines: keptLines, wasTruncated: true };
}

// ---------------------------------------------------------------------------
// last-summarized message id (in-memory + persisted)
// ---------------------------------------------------------------------------

let lastSummarizedMessageId: string | undefined;
let lastSummarizedHydrated = false;
let inFlightWrite: Promise<void> = Promise.resolve();

function hydrateLastSummarizedFromDisk(): void {
  if (lastSummarizedHydrated) return;
  lastSummarizedHydrated = true;
  const path = getLastSummarizedPath();
  try {
    // Sync read on first access keeps the getter synchronous (matches the
    // upstream surface and existing in-process callers). The file is tiny
    // (a single id) so this is negligible.
    const raw = readFileSyncSafe(path);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (parsed && typeof parsed.id === "string" && parsed.id.length > 0) {
      lastSummarizedMessageId = parsed.id;
    }
  } catch {
    // Corrupt or missing — leave undefined.
  }
}

function readFileSyncSafe(path: string): string | undefined {
  try {
    // Lazy require avoids loading the sync surface unless we need it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function getLastSummarizedMessageId(): string | undefined {
  hydrateLastSummarizedFromDisk();
  return lastSummarizedMessageId;
}

/**
 * Persist `id` (or clear, when undefined) as the last-summarized message id.
 * The in-memory copy is updated synchronously so subsequent
 * `getLastSummarizedMessageId()` calls return the new value immediately;
 * the disk write is fire-and-forget and serialized so concurrent setters
 * cannot interleave a partial write.
 */
export function setLastSummarizedMessageId(id: string | undefined): void {
  // Mark hydrated so a later read doesn't clobber what we just set.
  lastSummarizedHydrated = true;
  lastSummarizedMessageId = id;
  const path = getLastSummarizedPath();
  inFlightWrite = inFlightWrite.then(async () => {
    try {
      if (id === undefined) {
        // Clear: write an empty payload so a stale id can't resurrect.
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, JSON.stringify({ id: null }), {
          encoding: "utf8",
          mode: 0o600,
        });
        return;
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify({ id }), {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // Persistence is best-effort; the in-memory value is still correct.
    }
  });
}

/**
 * Test-only: drop in-process state. Disk state is left intact so callers
 * that care about a clean slate should also remove the memory dir.
 */
export function _resetSessionMemoryStateForTest(): void {
  lastSummarizedMessageId = undefined;
  lastSummarizedHydrated = false;
  extractionStartedAt = undefined;
  inFlightWrite = Promise.resolve();
}
