/**
 * Relevant durable-memory attachment producer.
 *
 * Searches the user's durable memory stores for files that are clearly useful
 * to the current turn, reads a bounded prefix of each selected file, and emits
 * them as `relevant_memories` user-context attachments. Rendering owns the
 * trust boundary; this producer owns selection, read bounds, and session dedupe.
 */

import { join, normalize, sep } from "node:path";

import {
  findRelevantMemories,
  formatRelevantMemoryHeader,
  isAutoMemoryEnabled,
  MEMORY_DIRNAME,
  PROJECT_MEMORY_DIR,
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
  if (!query || !/\s/.test(query)) return [];

  const dirs = getDurableMemorySearchDirs(opts.agencHome, opts.cwd);
  if (dirs.length === 0) return [];

  const selected = await selectRelevantMemories(
    query,
    dirs,
    opts.signal,
    trackingState.surfacedRelevantMemoryPaths,
  );
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
