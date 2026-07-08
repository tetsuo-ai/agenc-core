/**
 * Relevant durable-memory attachment producer.
 *
 * Searches the user's durable memory stores for files that are clearly useful
 * to the current turn, reads a bounded prefix of each selected file, and emits
 * them as `relevant_memories` user-context attachments. Rendering owns the
 * trust boundary; this producer owns selection, read bounds, and session dedupe.
 *
 * Two selection paths share the same budgets and dedupe state:
 *   - query-gated (every turn): a non-empty multi-word user prompt drives a
 *     model-side relevance selection (`findRelevantMemories`);
 *   - session-start (first producer run only, main thread only): when turn 0
 *     carries no substantive query, memories are selected by project/CWD
 *     signals — no model calls, header scans only — so sessions opened
 *     programmatically still start with project-relevant recall.
 */

import { join, normalize, sep } from "node:path";

import {
  findRelevantMemories,
  formatRelevantMemoryHeader,
  isAutoMemoryEnabled,
  MEMORY_DIRNAME,
  PROJECT_MEMORY_DIR,
  scanMemoryFiles,
  type MemoryHeader,
} from "../../memory/index.js";
import { readFileInRange } from "../../utils/readFileInRange.js";
import type { AttachmentProducer } from "./orchestrator.js";
import type { RelevantMemoriesAttachment } from "./types.js";

const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 4096;
const MAX_MEMORIES_PER_TURN = 5;
const MAX_SESSION_MEMORY_BYTES = 60 * 1024;

type SelectedMemory = {
  readonly path: string;
  readonly mtimeMs: number;
};

type SurfacedMemory = RelevantMemoriesAttachment["memories"][number];

export const relevantMemoriesProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  if (opts.signal.aborted) return [];
  if (!isAutoMemoryEnabled()) return [];
  if (trackingState.memoryMode === "disabled") return [];
  if (trackingState.surfacedRelevantMemoryBytes >= MAX_SESSION_MEMORY_BYTES) {
    return [];
  }

  const query = opts.userInput?.trim() ?? "";
  const hasSubstantiveQuery = query.length > 0 && /\s/.test(query);
  // Session-start recall is a one-shot: it may only fire on the first
  // producer run of the session, and only when the query-gated path will
  // not fire that turn (so a substantive turn-0 prompt never double-injects).
  const isFirstProducerRun = !trackingState.sessionStartMemoryRecallChecked;
  trackingState.sessionStartMemoryRecallChecked = true;
  if (!hasSubstantiveQuery && !isFirstProducerRun) return [];

  const dirs = getDurableMemorySearchDirs(opts.agencHome, opts.cwd);
  if (dirs.length === 0) return [];

  const selected = hasSubstantiveQuery
    ? await selectRelevantMemories(
        query,
        dirs,
        opts.signal,
        trackingState.surfacedRelevantMemoryPaths,
      )
    : opts.subagentDepth === 0
      ? await selectSessionStartMemories(
          opts.cwd,
          dirs,
          opts.signal,
          trackingState.surfacedRelevantMemoryPaths,
        )
      : [];
  if (selected.length === 0) return [];

  const remainingBytes =
    MAX_SESSION_MEMORY_BYTES - trackingState.surfacedRelevantMemoryBytes;
  const memories = await readMemoriesForAttachment(
    selected.slice(0, MAX_MEMORIES_PER_TURN),
    opts.signal,
    remainingBytes,
  );
  if (memories.length === 0) return [];

  for (const mem of memories) {
    trackingState.surfacedRelevantMemoryPaths.add(mem.path);
    trackingState.surfacedRelevantMemoryBytes += Buffer.byteLength(
      mem.content,
      "utf8",
    );
    if (mem.citation !== undefined) {
      trackingState.memoryCitations.push(mem.citation);
    }
  }

  return [{ kind: "relevant_memories", memories }];
};

function getDurableMemorySearchDirs(
  agencHome: string | undefined,
  cwd: string,
): string[] {
  if (agencHome === undefined || agencHome.trim().length === 0) return [];
  return Array.from(
    new Set([
      normalizeDir(join(agencHome, MEMORY_DIRNAME)),
      normalizeDir(join(cwd, PROJECT_MEMORY_DIR, MEMORY_DIRNAME)),
    ]),
  );
}

function normalizeDir(path: string): string {
  return `${normalize(path).replace(/[/\\]+$/, "")}${sep}`.normalize("NFC");
}

async function selectRelevantMemories(
  query: string,
  dirs: readonly string[],
  signal: AbortSignal,
  alreadySurfaced: ReadonlySet<string>,
): Promise<SelectedMemory[]> {
  const selectedByPath = new Map<string, SelectedMemory>();
  const perDir = await Promise.all(
    dirs.map((dir) =>
      findRelevantMemories(query, dir, signal, [], alreadySurfaced).catch(
        () => [],
      ),
    ),
  );
  for (const memory of perDir.flat()) {
    if (alreadySurfaced.has(memory.path)) continue;
    if (!selectedByPath.has(memory.path)) {
      selectedByPath.set(memory.path, memory);
    }
    if (selectedByPath.size >= MAX_MEMORIES_PER_TURN) break;
  }
  return [...selectedByPath.values()];
}

/**
 * Session-start selection: pick memories by project/CWD signals instead of
 * a user query. Runs once per session (main thread only), on the first
 * producer invocation without a substantive query. Deliberately cheap —
 * frontmatter-header scans only, no model calls:
 *   - project-memory-dir files are project-relevant by construction and
 *     rank first (newest-first, the scan order);
 *   - global-memory-dir files qualify only when their filename or
 *     description mentions a project signal token derived from the cwd.
 */
async function selectSessionStartMemories(
  cwd: string,
  dirs: readonly string[],
  signal: AbortSignal,
  alreadySurfaced: ReadonlySet<string>,
): Promise<SelectedMemory[]> {
  const projectDir = normalizeDir(join(cwd, PROJECT_MEMORY_DIR, MEMORY_DIRNAME));
  const tokens = projectSignalTokens(cwd);
  const perDir = await Promise.all(
    dirs.map(async (dir) => ({
      dir,
      headers: await scanMemoryFiles(dir, signal).catch(() => []),
    })),
  );
  const ranked: MemoryHeader[] = [
    ...perDir
      .filter(({ dir }) => dir === projectDir)
      .flatMap(({ headers }) => headers),
    ...perDir
      .filter(({ dir }) => dir !== projectDir)
      .flatMap(({ headers }) =>
        headers.filter((header) => matchesProjectSignals(header, tokens)),
      ),
  ];
  const selectedByPath = new Map<string, SelectedMemory>();
  for (const header of ranked) {
    if (alreadySurfaced.has(header.filePath)) continue;
    if (!selectedByPath.has(header.filePath)) {
      selectedByPath.set(header.filePath, {
        path: header.filePath,
        mtimeMs: header.mtimeMs,
      });
    }
    if (selectedByPath.size >= MAX_MEMORIES_PER_TURN) break;
  }
  return [...selectedByPath.values()];
}

/**
 * Project signal tokens from the workspace cwd: the last two path segments
 * (repo dir + its parent) plus their alphanumeric sub-tokens. Lowercased;
 * short fragments are dropped to limit accidental matches.
 */
function projectSignalTokens(cwd: string): readonly string[] {
  const segments = normalize(cwd)
    .split(sep)
    .filter((segment) => segment.length > 0)
    .slice(-2);
  const tokens = new Set<string>();
  for (const segment of segments) {
    const lower = segment.normalize("NFC").toLowerCase();
    if (lower.length >= 3) tokens.add(lower);
    for (const part of lower.split(/[^a-z0-9]+/)) {
      if (part.length >= 3) tokens.add(part);
    }
  }
  return [...tokens];
}

function matchesProjectSignals(
  header: MemoryHeader,
  tokens: readonly string[],
): boolean {
  if (tokens.length === 0) return false;
  const haystack = `${header.filename} ${header.description ?? ""}`
    .normalize("NFC")
    .toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

async function readMemoriesForAttachment(
  selected: readonly SelectedMemory[],
  signal: AbortSignal,
  remainingSessionBytes: number,
): Promise<SurfacedMemory[]> {
  const memories: SurfacedMemory[] = [];
  let remaining = remainingSessionBytes;

  for (const { path, mtimeMs } of selected) {
    if (remaining <= 0 || signal.aborted) break;
    const perFileByteLimit = Math.min(MAX_MEMORY_BYTES, remaining);
    try {
      const result = await readFileInRange(
        path,
        0,
        MAX_MEMORY_LINES,
        perFileByteLimit,
        signal,
        { truncateOnByteLimit: true },
      );
      const truncated =
        result.totalLines > MAX_MEMORY_LINES || result.truncatedByBytes === true;
      const content = truncated
        ? [
            result.content,
            "",
            `> This memory file was truncated (${result.truncatedByBytes === true ? `${perFileByteLimit} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Read the complete file directly before relying on omitted details: ${path}`,
          ].join("\n")
        : result.content;
      const lineEnd = Math.max(1, result.lineCount);
      const memory: SurfacedMemory = {
        path,
        content,
        mtimeMs,
        header: formatRelevantMemoryHeader(path, mtimeMs),
        ...(truncated ? { limit: result.lineCount } : {}),
        citation: {
          path,
          lineStart: 1,
          lineEnd,
          note: truncated
            ? "Relevant durable memory surfaced with a bounded prefix."
            : "Relevant durable memory surfaced.",
          rolloutIds: ["relevant-memory-attachment"],
        },
      };
      memories.push(memory);
      remaining -= Buffer.byteLength(content, "utf8");
    } catch {
      continue;
    }
  }

  return memories;
}
