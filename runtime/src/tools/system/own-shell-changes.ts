/**
 * Changes the session's own shell commands make to files it has read.
 *
 * AgenC's file tools (Write, Edit, apply_patch, NotebookEdit) record what they
 * wrote as the session's view of the file, so the changed-files attachment
 * producer (`prompts/attachments/changed-files.ts`) never sends their writes
 * back to the model. A shell command records nothing, so before this module
 * every shell change to a file the session had read came back as a
 * "changed file" diff on the next request and stayed in every later request:
 * a CSV the model appended to with `printf >>` once per item was sent again
 * after each append.
 *
 * A shell tool runs its command inside {@link trackOwnShellChanges}. Before the
 * command starts, each read file whose disk state is still the one the session
 * last saw (or the one its own previous command left) is stat'ed; when the
 * command returns, every one of those files whose state moved is recorded with
 * its new state. The producer treats a change as the session's own only while
 * the file still has exactly that state, and then refreshes the session's view
 * as it does after sending a diff, so the read-before-write checks see what
 * they saw before. A file that changed before the command started, or changes
 * again after it returned (an editor, another process, a background job), is
 * sent as before.
 *
 * @module
 */

import { stat } from "node:fs/promises";

import {
  fileStatFingerprint,
  forEachSessionRead,
  ownShellChangeOf,
  recordOwnShellChange,
  resolveSessionId,
  sameFileStat,
  type FileStatFingerprint,
} from "./filesystem.js";

async function statFingerprint(path: string): Promise<FileStatFingerprint | undefined> {
  try {
    return fileStatFingerprint(await stat(path));
  } catch {
    return undefined;
  }
}

/** Read files the session's view still matches, with their state now. */
async function filesInView(sessionId: string): Promise<Map<string, FileStatFingerprint>> {
  const tracked: Array<{ readonly path: string; readonly timestamp: number | undefined }> = [];
  forEachSessionRead(sessionId, (path, snapshot) => {
    // The producer's own selection: full views that carry their raw bytes.
    if (typeof snapshot.rawContent !== "string" || snapshot.isPartialView === true) return;
    tracked.push({ path, timestamp: snapshot.timestamp });
  });
  const inView = new Map<string, FileStatFingerprint>();
  await Promise.all(
    tracked.map(async ({ path, timestamp }) => {
      const now = await statFingerprint(path);
      if (now === undefined) return;
      const unchangedSinceRead = typeof timestamp === "number" && now.mtimeMs <= timestamp;
      if (unchangedSinceRead || sameFileStat(now, ownShellChangeOf(sessionId, path))) {
        inView.set(path, now);
      }
    }),
  );
  return inView;
}

/**
 * Run one shell command of the session (`run`) and record which of its read
 * files the command changed. Without a session id, or for a command that runs
 * in a sandbox without write access (`mayWrite` false), it only runs the
 * command: such a command changes nothing, and a change made meanwhile is not
 * its own.
 */
export async function trackOwnShellChanges<T>(
  args: Record<string, unknown>,
  run: () => Promise<T>,
  mayWrite = true,
): Promise<T> {
  const sessionId = mayWrite ? resolveSessionId(args) : undefined;
  const before = sessionId === undefined ? undefined : await filesInView(sessionId);
  try {
    return await run();
  } finally {
    if (sessionId !== undefined && before !== undefined && before.size > 0) {
      await Promise.all(
        [...before].map(async ([path, previous]) => {
          const after = await statFingerprint(path);
          if (after !== undefined && !sameFileStat(after, previous)) {
            recordOwnShellChange(sessionId, path, after);
          }
        }),
      );
    }
  }
}
