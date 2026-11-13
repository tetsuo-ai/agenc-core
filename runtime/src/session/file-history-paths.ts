import { createHash } from "node:crypto";

/**
 * Name of the directory, under `<projectDir>/file-history/`, that holds one
 * conversation's snapshot index and file backups: `session-` followed by the
 * first 16 hex digits of the SHA-256 of the session id.
 *
 * The file-history engine writes this directory and session retention removes
 * it, so both take the name from here. Directories on disk already carry it:
 * the value for a given session id must never change.
 */
export function fileHistorySessionDirName(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `session-${digest.slice(0, 16)}`;
}
