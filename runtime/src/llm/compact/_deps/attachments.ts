/**
 * Attachment-message helpers for compact prompt assembly. The
 * openclaude runtime threads file/agent/tool/MCP-instruction
 * attachments into the post-compact context; the gut runtime owns its
 * own attachment surface (`runtime/src/prompts/memory/attachments.ts`)
 * for memory injection but does not yet have an equivalent for the
 * compact-time deltas. These helpers produce the minimum
 * AttachmentMessage shape compact's prompt assembly needs.
 *
 * `generateFileAttachment` is a gut-local port of the upstream
 * `src/utils/attachments.ts::generateFileAttachment` from
 * /home/tetsuo/git/claude — adapted to gut primitives: plain
 * `node:fs/promises` reads, BOM strip, line-ending normalize,
 * line-count cap (`MAX_LINES_TO_READ`), and per-file token cap
 * threaded through `toolUseContext.fileReadingLimits.maxTokens`
 * (POST_COMPACT_MAX_TOKENS_PER_FILE in compact.ts).
 *
 * The agent-listing / deferred-tools / MCP-instructions delta
 * helpers are intentionally still no-op: gut does not yet have the
 * upstream tool-search, agent-pool, or MCP-instructions delta state
 * machines. They keep the same iterable contract so compact's call
 * sites can stay unchanged.
 */

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

interface AttachmentLike {
  readonly type?: string;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

export interface AttachmentMessage {
  readonly type: "attachment";
  readonly uuid: string;
  readonly timestamp: string;
  readonly attachment: AttachmentLike;
}

export function createAttachmentMessage(
  attachment: AttachmentLike,
): AttachmentMessage {
  return {
    type: "attachment",
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    attachment,
  };
}

/**
 * Mirrors the upstream `FileAttachment` contract. `content` follows the
 * `FileReadTool` `text` output discriminant so post-compact prompt
 * assembly can render it the same way as a fresh Read tool result.
 *
 * The `[key: string]: unknown` index signature keeps the type
 * structurally assignable to `AttachmentLike` (which `createAttachmentMessage`
 * accepts) without forcing every consumer to widen at the call site.
 */
export interface FileAttachment {
  readonly type: "file";
  readonly filename: string;
  readonly displayPath: string;
  readonly truncated?: boolean;
  readonly content: {
    readonly type: "text";
    readonly file: {
      readonly filePath: string;
      readonly content: string;
      readonly numLines: number;
      readonly startLine: number;
      readonly totalLines: number;
    };
  };
  readonly [key: string]: unknown;
}

/**
 * Lightweight reference attachment for files that were too big to inline
 * in `'compact'` mode. Matches upstream `CompactFileReferenceAttachment`.
 */
export interface CompactFileReferenceAttachment {
  readonly type: "compact_file_reference";
  readonly filename: string;
  readonly displayPath: string;
  readonly [key: string]: unknown;
}

/**
 * Maximum number of lines we'll read per file when building a post-compact
 * file attachment. Matches upstream `MAX_LINES_TO_READ` in
 * `src/tools/FileReadTool/prompt.ts`.
 */
const MAX_LINES_TO_READ = 2000;

/**
 * Default maximum bytes we'll even try to read for a text attachment if
 * the caller does not pass `fileReadingLimits.maxSizeBytes`. Mirrors the
 * upstream `MAX_OUTPUT_SIZE` order of magnitude (256 KB).
 */
const DEFAULT_MAX_SIZE_BYTES = 256 * 1024;

/**
 * Rough chars-per-token estimate used to cap content size against
 * `fileReadingLimits.maxTokens`. Matches the heuristic used in
 * `_deps/token-counts.ts` (4 chars per token).
 */
const CHARS_PER_TOKEN = 4;

interface FileReadingLimits {
  readonly maxTokens?: number;
  readonly maxSizeBytes?: number;
}

interface GenerateFileAttachmentContext {
  readonly fileReadingLimits?: FileReadingLimits;
  readonly cwd?: string;
  readonly options?: { readonly cwd?: string };
  readonly readFileState?: ReadonlyMap<string, unknown> | Map<string, unknown>;
}

function stripBOM(content: string): string {
  if (content.length > 0 && content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

function normalizeLineEndings(text: string): string {
  if (text.length === 0) return text;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function resolveCwd(context: GenerateFileAttachmentContext | undefined): string {
  return context?.cwd ?? context?.options?.cwd ?? process.cwd();
}

function resolveDisplayPath(filename: string, cwd: string): string {
  try {
    const absolute = isAbsolute(filename) ? filename : resolve(cwd, filename);
    const rel = relative(cwd, absolute);
    return rel.length > 0 ? rel : filename;
  } catch {
    return filename;
  }
}

function resolveAbsolutePath(filename: string, cwd: string): string {
  return isAbsolute(filename) ? filename : resolve(cwd, filename);
}

function logEvent(_eventName: string): void {
  // Telemetry is intentionally a no-op in the gut runtime; compact only
  // depends on the structural attachment result, not the analytics signal.
}

/**
 * Read a file from disk and produce a `FileAttachment` (or
 * `CompactFileReferenceAttachment` if the file is too big for the
 * caller's per-file token / byte budget in `'compact'` mode).
 *
 * Returns `null` when:
 *   - the file does not exist or cannot be stat'd
 *   - the file cannot be read (permission, IO error, decode error)
 *   - the file is too big AND the mode is not `'compact'`
 *
 * Adapted from upstream `generateFileAttachment` in
 * `/home/tetsuo/git/claude/src/utils/attachments.ts`. The upstream impl
 * routes through `FileReadTool.call`, which the gut runtime does not
 * own at this layer; we substitute a direct text read with line and
 * token caps that produces the same `FileAttachment` content shape the
 * downstream compact prompt expects.
 */
export async function generateFileAttachment(
  filename: string,
  toolUseContext?: GenerateFileAttachmentContext,
  successEventName?: string,
  errorEventName?: string,
  mode: "compact" | "at-mention" = "compact",
  options?: { readonly offset?: number; readonly limit?: number },
): Promise<FileAttachment | CompactFileReferenceAttachment | null> {
  if (!filename) return null;

  const cwd = resolveCwd(toolUseContext);
  const absolutePath = resolveAbsolutePath(filename, cwd);
  const displayPath = resolveDisplayPath(filename, cwd);

  const limits: FileReadingLimits = toolUseContext?.fileReadingLimits ?? {};
  const maxTokens =
    typeof limits.maxTokens === "number" && limits.maxTokens > 0
      ? limits.maxTokens
      : undefined;
  const maxSizeBytes =
    typeof limits.maxSizeBytes === "number" && limits.maxSizeBytes > 0
      ? limits.maxSizeBytes
      : DEFAULT_MAX_SIZE_BYTES;
  // Convert the token budget to a byte budget using the same coarse
  // chars-per-token heuristic the rest of the compact subsystem uses.
  // This is a proxy for the upstream `MaxFileReadTokenExceededError`
  // post-read check.
  const tokenByteBudget =
    maxTokens !== undefined ? maxTokens * CHARS_PER_TOKEN : Infinity;

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(absolutePath);
  } catch {
    if (errorEventName) logEvent(errorEventName);
    return null;
  }
  if (!stats.isFile()) {
    if (errorEventName) logEvent(errorEventName);
    return null;
  }

  const tooLargeOnDisk = stats.size > maxSizeBytes;

  function buildCompactReference(): CompactFileReferenceAttachment {
    return {
      type: "compact_file_reference",
      filename: absolutePath,
      displayPath,
    };
  }

  // Pre-read size gate: if the on-disk file is bigger than
  // `maxSizeBytes`, take the reference branch in `'compact'` mode
  // without attempting a full read (matches upstream behavior — return
  // a lightweight `compact_file_reference` instead of inlining the
  // file). For non-compact modes the gut surface is not exercised by
  // the compact pipeline today, so we fail closed.
  if (tooLargeOnDisk) {
    if (mode === "compact") {
      if (successEventName) logEvent(successEventName);
      return buildCompactReference();
    }
    if (errorEventName) logEvent(errorEventName);
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    if (errorEventName) logEvent(errorEventName);
    return null;
  }

  const normalized = normalizeLineEndings(stripBOM(raw));
  const allLines = normalized.split("\n");
  const totalLines = allLines.length;

  const startLine = Math.max(1, options?.offset ?? 1);
  const limit = Math.max(1, options?.limit ?? MAX_LINES_TO_READ);
  // Guard against offsets past EOF — clamp to the available range.
  const startIndex = Math.min(Math.max(startLine - 1, 0), Math.max(totalLines - 1, 0));
  const endIndex = Math.min(totalLines, startIndex + limit);
  const sliced = allLines.slice(startIndex, endIndex);
  let content = sliced.join("\n");
  let numLines = sliced.length;
  // `tooLargeOnDisk` is unreachable here — the pre-read gate above
  // returns a compact reference (compact mode) or null (other modes)
  // before we reach the slice. Keep the line count gate only.
  let truncated = endIndex < totalLines;

  // Post-read token cap: if the read content is over the per-file
  // token budget, either return a compact reference (in `'compact'`
  // mode) or hard-truncate further.
  if (content.length > tokenByteBudget) {
    if (mode === "compact") {
      return buildCompactReference();
    }
    // At-mention: re-slice down to fit the byte budget by line count.
    let trimmed = sliced;
    let trimmedContent = content;
    while (trimmed.length > 1 && trimmedContent.length > tokenByteBudget) {
      trimmed = trimmed.slice(0, Math.max(1, Math.floor(trimmed.length / 2)));
      trimmedContent = trimmed.join("\n");
    }
    content = trimmedContent;
    numLines = trimmed.length;
    truncated = true;
  }

  if (successEventName) logEvent(successEventName);

  return {
    type: "file",
    filename: absolutePath,
    displayPath,
    truncated,
    content: {
      type: "text",
      file: {
        filePath: absolutePath,
        content,
        numLines,
        startLine,
        totalLines,
      },
    },
  };
}

export function getAgentListingDeltaAttachment(
  ..._args: unknown[]
): AttachmentLike[] {
  return [];
}

export function getDeferredToolsDeltaAttachment(
  ..._args: unknown[]
): AttachmentLike[] {
  return [];
}

export function getMcpInstructionsDeltaAttachment(
  ..._args: unknown[]
): AttachmentLike[] {
  return [];
}
