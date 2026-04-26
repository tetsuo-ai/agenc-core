/**
 * Relevant-memory attachment producer.
 *
 * Hand-port of openclaude `getRelevantMemoryAttachments()`
 * (`src/utils/attachments.ts:2197-2243`), bridged onto AgenC's existing
 * `selectRelevantMemoriesForTurn()` ranker
 * (`runtime/src/prompts/memory/attachments.ts:174`).
 *
 * Discovery model: the producer reads an optional `memoryDir` field from
 * `opts.sessionKey` (the canonical sessionKey is the live `Session`
 * instance — this matches existing AgenC convention for per-session
 * fields not on the orchestrator surface). When absent, the producer
 * returns []. The bootstrap call site can attach `memoryDir` to the
 * Session for full wiring; until then this is a no-op for sessions
 * without it.
 *
 * Caps: `selectRelevantMemoriesForTurn` already enforces the per-turn
 * file count, per-file byte cap, and cumulative per-session 60KB budget
 * documented at `attachments.ts:30-38`. No additional caps are applied
 * here.
 *
 * Dedup: openclaude filters memories the model has already read this
 * session via `readFileState.has(m.path)`. AgenC's analog is
 * `hasSessionRead()`. The producer applies that filter.
 *
 * @module
 */

import { stat } from "node:fs/promises";

import { hasSessionRead } from "../../tools/system/filesystem.js";
import { scanMemoryDir } from "../memory/scan.js";
import { selectRelevantMemoriesForTurn } from "../memory/attachments.js";
import { serializeMemory } from "../memory/types.js";
import type { RelevantMemoriesAttachment } from "./types.js";
import type {
  AttachmentProducer,
  GetAttachmentsOptions,
} from "./orchestrator.js";

/**
 * Optional per-session fields the producer reads off the opaque
 * `sessionKey` object. Wired by the bootstrap when memory is enabled
 * for the session. Production sessions expose `conversationId`; test
 * fixtures sometimes set `sessionId` directly. Either is accepted.
 */
interface MemoryAwareSessionKey {
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly memoryDir?: string;
}

function readMemoryAwareKey(
  opts: GetAttachmentsOptions,
): MemoryAwareSessionKey {
  const raw = opts.sessionKey as MemoryAwareSessionKey;
  const id =
    typeof raw.conversationId === "string" && raw.conversationId.length > 0
      ? raw.conversationId
      : typeof raw.sessionId === "string" && raw.sessionId.length > 0
        ? raw.sessionId
        : undefined;
  return {
    ...(id !== undefined ? { sessionId: id } : {}),
    ...(typeof raw.memoryDir === "string" ? { memoryDir: raw.memoryDir } : {}),
  };
}

function buildMemoryHeader(path: string, mtimeMs: number): string {
  // Mirror openclaude `memoryHeader()` (attachments.ts:2328-2333) shape.
  // Exact prose is not load-bearing — the renderer in messages.ts uses
  // the header verbatim when present.
  const mtimeIso = new Date(mtimeMs).toISOString();
  return `## ${path} (mtime: ${mtimeIso})`;
}

export const relevantMemoryProducer: AttachmentProducer = async (opts) => {
  const key = readMemoryAwareKey(opts);
  const memoryDir = key.memoryDir;
  const sessionId = key.sessionId;

  if (typeof memoryDir !== "string" || memoryDir.length === 0) {
    return [];
  }
  if (typeof opts.userInput !== "string" || opts.userInput.length === 0) {
    return [];
  }

  const scan = await scanMemoryDir(memoryDir);
  if (scan.entries.length === 0) return [];

  // Filter out memory files the model has already read this session.
  const eligible = scan.entries.filter(
    (entry) => !hasSessionRead(sessionId, entry.filePath),
  );
  if (eligible.length === 0) return [];

  const selected = selectRelevantMemoriesForTurn(
    eligible,
    opts.userInput,
    opts.sessionKey,
  );
  if (selected.length === 0) return [];

  const memories: RelevantMemoriesAttachment["memories"][number][] = [];
  for (const entry of selected) {
    if (opts.signal.aborted) break;
    let mtimeMs = entry.mtimeMs;
    try {
      const st = await stat(entry.filePath);
      mtimeMs = st.mtimeMs;
    } catch {
      // Best effort — keep the existing mtime.
    }
    const content = serializeMemory({
      frontmatter: entry.frontmatter,
      body: entry.body,
    });
    memories.push({
      path: entry.filePath,
      content,
      mtimeMs,
      header: buildMemoryHeader(entry.filePath, mtimeMs),
    });
  }
  if (memories.length === 0) return [];
  return [{ kind: "relevant_memories", memories }];
};
