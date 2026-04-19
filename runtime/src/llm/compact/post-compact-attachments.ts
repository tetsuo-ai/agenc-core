/**
 * Post-compaction file re-attachment helpers.
 *
 * After a compaction pass summarizes older tool history, the raw bytes
 * of files the model had recently read disappear from the prompt. The
 * model then burns follow-up rounds re-calling `system.readFile` for
 * paths it was just looking at. Mirrors the reference runtime's
 * `createPostCompactFileAttachments` pattern: snapshot the top-N
 * most-recently-read files, clear the per-session read cache, and
 * re-inject the file contents as `<anchor-file>` system messages that
 * sit just after the compaction boundary in the new prompt.
 *
 * The chars-per-file and total-chars budgets are conservative. Over the
 * grok/claude ~4-chars-per-token ratio these roughly match upstream's
 * 5K/file + 50K envelope. The helpers are shared between the chat
 * executor's in-flight compaction path and the background-run
 * supervisor's internal compaction path so both exits produce
 * byte-identical anchor messages for the same snapshot input.
 *
 * @module
 */

import {
  clearSessionReadCache,
  snapshotTopRecentReads,
  type SessionReadSnapshotExport,
} from "../../tools/system/filesystem.js";
import type { LLMMessage } from "../types.js";

export const POST_COMPACT_MAX_FILES_TO_REATTACH = 5;
export const POST_COMPACT_PER_FILE_BUDGET_CHARS = 20_000;
export const POST_COMPACT_TOTAL_BUDGET_CHARS = 200_000;

/**
 * Wrap a file snapshot as a `system`-role anchor message whose content
 * block is a well-known `<anchor-file>` tagged region. The anchor tag
 * gives the model a stable, easy-to-scan re-reference point and tells
 * it explicitly not to re-invoke `system.readFile` for the attached
 * path.
 */
export function buildAnchorFileMessage(
  snapshot: SessionReadSnapshotExport,
): LLMMessage {
  const header =
    `<anchor-file path="${snapshot.path}" viewKind="${snapshot.viewKind ?? "full"}">`;
  const footer = "</anchor-file>";
  return {
    role: "system",
    content:
      `${header}\n${snapshot.content}\n${footer}\n` +
      `[reattached from pre-compaction read cache; refer to the anchor-file ` +
      `block above instead of re-calling system.readFile for this path]`,
  };
}

/**
 * Snapshot the top-N most-recently-read files for this session,
 * build their anchor messages, and clear the session's in-memory read
 * cache. Safe to call when no reads have happened — returns an empty
 * array.
 *
 * The caller inserts the returned messages into the compacted history
 * immediately after the compaction boundary so the attached content
 * stays inside the cacheable prefix but outside the recent-tail slice
 * that changes every round.
 */
export function reattachRecentFilesOnCompaction(
  sessionId: string,
  options?: {
    readonly maxFiles?: number;
    readonly perFileBudgetChars?: number;
    readonly totalBudgetChars?: number;
  },
): readonly LLMMessage[] {
  const snapshots = snapshotTopRecentReads({
    sessionId,
    maxFiles: options?.maxFiles ?? POST_COMPACT_MAX_FILES_TO_REATTACH,
    perFileBudgetChars:
      options?.perFileBudgetChars ?? POST_COMPACT_PER_FILE_BUDGET_CHARS,
    totalBudgetChars:
      options?.totalBudgetChars ?? POST_COMPACT_TOTAL_BUDGET_CHARS,
  });
  clearSessionReadCache(sessionId);
  if (snapshots.length === 0) {
    return [];
  }
  return snapshots.map((snapshot) => buildAnchorFileMessage(snapshot));
}
