/**
 * Changed-files attachment producer.
 *
 * Hand-port of reference `getChangedFiles()`
 * (`src/utils/attachments.ts:2064-2162`). For each file the model has
 * read this session, stat the file on disk and detect mid-session
 * mutation. Emit one attachment per changed file:
 *
 *   - text files → `edited_text_file` carrying a diff snippet
 *   - image files → `edited_image_file` carrying base64 bytes
 *
 * After emitting, update the in-memory snapshot so subsequent turns do
 * not re-fire the same change.
 *
 * Files that disappear (ENOENT) are evicted from the read cache; other
 * stat failures (atomic-save races, EACCES churn, transient FS errors)
 * intentionally do NOT evict — that matches the AgenC regression
 * fix called out at `attachments.ts:2147-2156`.
 *
 * @module
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { structuredPatch } from "diff";

import {
  dropSessionReadSnapshot,
  forEachSessionRead,
  recordSessionRead,
} from "../../tools/system/filesystem.js";
import type {
  EditedImageFileAttachment,
  EditedTextFileAttachment,
} from "./types.js";
import type {
  AttachmentProducer,
  GetAttachmentsOptions,
} from "./orchestrator.js";

/** Image extensions the producer recognizes (mirrors `file-read.ts`). */
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Cap on the diff snippet bytes to avoid runaway large pastes. */
const DIFF_SNIPPET_MAX_BYTES = 16_000;

/** Diff structuredPatch timeout, ms (matches AgenC default). */
const DIFF_TIMEOUT_MS = 1_000;

/**
 * Pull the canonical session id off the opaque session-key object.
 *
 * Production sessions are Session instances whose canonical id is on
 * `conversationId` — that's the value the dispatcher injects as
 * `__agencSessionId` into every filesystem-tool call, so it's the same
 * key under which the session-read state is recorded. Tests sometimes
 * pass a bare `{ sessionId: "..." }` shape; accept that as a fallback.
 */
function resolveSessionId(opts: GetAttachmentsOptions): string | undefined {
  const key = opts.sessionKey as {
    conversationId?: unknown;
    sessionId?: unknown;
  };
  if (
    typeof key.conversationId === "string" &&
    key.conversationId.trim().length > 0
  ) {
    return key.conversationId;
  }
  if (typeof key.sessionId === "string" && key.sessionId.trim().length > 0) {
    return key.sessionId;
  }
  return undefined;
}

interface PendingFile {
  readonly path: string;
  readonly previousRaw: string;
  readonly previousTimestamp: number | undefined;
}

/**
 * Compute a compact diff snippet between two text contents. Mirrors
 * reference `getSnippetForTwoFileDiff` (FileEditTool/utils.ts:362).
 *
 * Returns "" when the contents are byte-identical. Returns a hunk-only
 * snippet (with deleted lines stripped, only kept lines numbered) when
 * they differ. Truncates to {@link DIFF_SNIPPET_MAX_BYTES}.
 */
function computeSnippet(before: string, after: string): string {
  if (before === after) return "";
  const patch = structuredPatch(
    "file.txt",
    "file.txt",
    before,
    after,
    undefined,
    undefined,
    {
      context: 8,
      timeout: DIFF_TIMEOUT_MS,
    },
  );
  if (!patch || patch.hunks.length === 0) return "";

  const blocks = patch.hunks.map((hunk) => {
    const kept = hunk.lines.filter(
      (line) => !line.startsWith("-") && !line.startsWith("\\"),
    );
    let lineNumber = hunk.newStart;
    const numbered = kept.map((line) => {
      const text = line.length > 0 ? line.slice(1) : "";
      const numbered = `${String(lineNumber).padStart(5, " ")}\t${text}`;
      lineNumber += 1;
      return numbered;
    });
    return numbered.join("\n");
  });
  const full = blocks.join("\n...\n");

  if (Buffer.byteLength(full, "utf8") <= DIFF_SNIPPET_MAX_BYTES) {
    return full;
  }
  const cutoff = full.lastIndexOf("\n", DIFF_SNIPPET_MAX_BYTES);
  const kept = cutoff > 0 ? full.slice(0, cutoff) : full.slice(0, DIFF_SNIPPET_MAX_BYTES);
  return `${kept}\n\n... [snippet truncated] ...`;
}

/** ENOENT type guard. */
function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Producer entrypoint.
 *
 * Iterates the session-read map (the in-memory portion only — see
 * `forEachSessionRead`) and emits attachments for files whose mtime is
 * newer than the recorded read timestamp. Updates the cache entry on
 * each emission so the same change does not re-fire next turn.
 *
 * Skips files whose snapshot lacks a populated `rawContent` field —
 * those are partial reads or pre-rawContent compatibility entries that cannot
 * support a precise diff. The foundation has wired the field on
 * `SessionReadSnapshot` itself; downstream wiring through file-read.ts /
 * file-edit.ts / file-write.ts to actually populate it lands in a
 * follow-up commit.
 */
export const changedFilesProducer: AttachmentProducer = async (opts) => {
  const sessionId = resolveSessionId(opts);
  if (!sessionId) return [];

  const pending: PendingFile[] = [];
  forEachSessionRead(sessionId, (path, snapshot) => {
    if (typeof snapshot.rawContent !== "string") return;
    if (snapshot.isPartialView === true) return;
    pending.push({
      path,
      previousRaw: snapshot.rawContent,
      previousTimestamp: snapshot.timestamp,
    });
  });
  if (pending.length === 0) return [];

  const out: Array<EditedTextFileAttachment | EditedImageFileAttachment> = [];

  await Promise.all(
    pending.map(async (entry) => {
      if (opts.signal.aborted) return;
      let st;
      try {
        st = await stat(entry.path);
      } catch (err) {
        if (isENOENT(err)) {
          dropSessionReadSnapshot(sessionId, entry.path);
        }
        return;
      }
      if (
        typeof entry.previousTimestamp === "number" &&
        st.mtimeMs <= entry.previousTimestamp
      ) {
        return;
      }

      const ext = extname(entry.path).toLowerCase();
      const mediaType = IMAGE_MIME_BY_EXT[ext];

      if (mediaType !== undefined) {
        let bytes: Buffer;
        try {
          bytes = await readFile(entry.path);
        } catch {
          return;
        }
        out.push({
          kind: "edited_image_file",
          filename: entry.path,
          content: bytes.toString("base64"),
          mediaType,
        });
        recordSessionRead(sessionId, entry.path, {
          rawContent: bytes.toString("base64"),
          timestamp: st.mtimeMs,
          viewKind: "full",
        });
        return;
      }

      let nextRaw: string;
      try {
        nextRaw = await readFile(entry.path, "utf8");
      } catch {
        return;
      }
      const snippet = computeSnippet(entry.previousRaw, nextRaw);
      if (snippet === "") {
        // mtime bumped (touch) but content identical — refresh timestamp
        // so we don't re-stat next turn.
        recordSessionRead(sessionId, entry.path, {
          rawContent: nextRaw,
          timestamp: st.mtimeMs,
          viewKind: "full",
        });
        return;
      }
      out.push({
        kind: "edited_text_file",
        filename: entry.path,
        snippet,
      });
      recordSessionRead(sessionId, entry.path, {
        rawContent: nextRaw,
        timestamp: st.mtimeMs,
        viewKind: "full",
      });
    }),
  );

  return out;
};
