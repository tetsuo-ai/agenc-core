import { Buffer } from "node:buffer";
import { isAbsolute, join, normalize, sep } from "node:path";

import {
  findRelevantMemories,
  formatRelevantMemoryHeader,
  isAutoMemoryEnabled,
  MEMORY_DIRNAME,
  PROJECT_MEMORY_DIR,
  readMemoryContent,
  resolveMemoryIndexDatabasePath,
  type MemoryRecallMode,
  type RelevantMemory,
} from "../../memory/index.js";
import {
  isMemoryRecallAbort,
  MAX_RELEVANT_MEMORIES,
  throwIfMemoryRecallAborted,
} from "../../memory/recall-contract.js";
import type { LLMMessage } from "../../llm/types.js";
import type { AttachmentProducer } from "./orchestrator.js";
import type { RelevantMemoriesAttachment } from "./types.js";

const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 4_096;
const MAX_SESSION_MEMORY_BYTES = 60 * 1_024;
const RELEVANT_MEMORY_ROLLOUT_ID = "relevant-memory-attachment";

type SurfacedMemory = RelevantMemoriesAttachment["memories"][number];

export const relevantMemoriesProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  throwIfMemoryRecallAborted(opts.signal);
  if (!isAutoMemoryEnabled()) return [];
  if (trackingState.memoryMode === "disabled") return [];
  if (trackingState.surfacedRelevantMemoryBytes >= MAX_SESSION_MEMORY_BYTES) {
    return [];
  }

  const query = opts.userInput?.trim() ?? "";
  const mode = selectRecallMode(query, opts.subagentDepth, trackingState);
  if (mode === null) return [];
  const memoryDirs = durableMemorySearchDirs(opts.agencHome, opts.cwd);
  if (memoryDirs.length === 0) return [];

  const selected = await findRelevantMemories({
    query,
    memoryDirs,
    signal: opts.signal,
    mode,
    recentTools: collectRecentToolNames(opts.messages),
    alreadySurfaced: trackingState.surfacedRelevantMemoryPaths,
    ...(opts.admittedMemorySelector !== undefined
      ? { admittedMemorySelector: opts.admittedMemorySelector }
      : {}),
    ...(opts.agencHome !== undefined && isAbsolute(opts.agencHome)
      ? {
          memoryIndexDatabasePath: resolveMemoryIndexDatabasePath(
            opts.agencHome,
          ),
        }
      : {}),
  });
  if (selected.length === 0) return [];

  const remainingBytes =
    MAX_SESSION_MEMORY_BYTES - trackingState.surfacedRelevantMemoryBytes;
  const memories = await readMemoriesForAttachment(
    selected.slice(0, MAX_RELEVANT_MEMORIES),
    opts.signal,
    remainingBytes,
  );
  for (const memory of memories) {
    trackingState.surfacedRelevantMemoryPaths.add(memory.path);
    trackingState.surfacedRelevantMemoryBytes += Buffer.byteLength(
      memory.content,
      "utf8",
    );
    if (memory.citation !== undefined) {
      trackingState.memoryCitations.push(memory.citation);
    }
  }
  return memories.length === 0 ? [] : [{ kind: "relevant_memories", memories }];
};

function collectRecentToolNames(messages: readonly LLMMessage[]): string[] {
  const recent: string[] = [];
  const seen = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && message.toolCallId === undefined) break;
    if (
      message.role !== "tool" ||
      message.toolName === undefined ||
      seen.has(message.toolName)
    ) {
      continue;
    }
    seen.add(message.toolName);
    recent.push(message.toolName);
  }
  return recent;
}

function selectRecallMode(
  query: string,
  subagentDepth: number,
  trackingState: {
    sessionStartMemoryRecallChecked: boolean;
  },
): MemoryRecallMode | null {
  const firstRun = !trackingState.sessionStartMemoryRecallChecked;
  trackingState.sessionStartMemoryRecallChecked = true;
  if (query.length > 0) return "query";
  return firstRun && subagentDepth === 0 ? "session_start" : null;
}

function durableMemorySearchDirs(
  agencHome: string | undefined,
  cwd: string,
): string[] {
  if (agencHome === undefined || agencHome.trim().length === 0) return [];
  return Array.from(
    new Set([
      normalizeDirectory(join(agencHome, MEMORY_DIRNAME)),
      normalizeDirectory(join(cwd, PROJECT_MEMORY_DIR, MEMORY_DIRNAME)),
    ]),
  );
}

function normalizeDirectory(path: string): string {
  return `${normalize(path).replace(/[/\\]+$/u, "")}${sep}`.normalize("NFC");
}

async function readMemoriesForAttachment(
  selected: readonly RelevantMemory[],
  signal: AbortSignal,
  remainingSessionBytes: number,
): Promise<SurfacedMemory[]> {
  const memories: SurfacedMemory[] = [];
  let remaining = remainingSessionBytes;

  for (const selectedMemory of selected) {
    throwIfMemoryRecallAborted(signal);
    if (remaining <= 0) break;
    const perFileByteLimit = Math.min(MAX_MEMORY_BYTES, remaining);
    try {
      const result = await readMemoryContent(
        selectedMemory.header,
        signal,
        perFileByteLimit,
        MAX_MEMORY_LINES,
      );
      const unboundedContent = result.truncated
        ? [
            result.content,
            "",
            `> This memory file was truncated at the bounded recall limit. Read the complete file directly before relying on omitted details: ${selectedMemory.path}`,
          ].join("\n")
        : result.content;
      const content = truncateUtf8(unboundedContent, remaining);
      const lineEnd = Math.max(1, result.lineCount);
      memories.push({
        path: selectedMemory.path,
        content,
        mtimeMs: selectedMemory.mtimeMs,
        header: formatRelevantMemoryHeader(
          selectedMemory.path,
          selectedMemory.mtimeMs,
        ),
        ...(result.truncated ? { limit: result.lineCount } : {}),
        selectionSource: selectedMemory.selectionSource,
        citation: {
          path: selectedMemory.path,
          lineStart: 1,
          lineEnd,
          note: result.truncated
            ? "Relevant durable memory surfaced with a bounded prefix."
            : "Relevant durable memory surfaced.",
          rolloutIds: [RELEVANT_MEMORY_ROLLOUT_ID],
        },
      });
      remaining -= Buffer.byteLength(content, "utf8");
    } catch (error) {
      if (isMemoryRecallAbort(error, signal)) throw signal.reason ?? error;
    }
  }
  return memories;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const codepoint of value) {
    const codepointBytes = Buffer.byteLength(codepoint, "utf8");
    if (bytes + codepointBytes > maximumBytes) break;
    output += codepoint;
    bytes += codepointBytes;
  }
  return output;
}
