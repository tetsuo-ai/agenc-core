/**
 * Composer history persistence — reads and writes
 * `<home>/.agenc/history.jsonl`.
 *
 * Each submitted message is appended as a single JSON Lines entry:
 *   {"timestamp": 1712345678901, "value": "npm test", "cwd": "/tmp/app"}
 *
 * Reads tolerate malformed lines (skipped silently) so a truncated
 * write — e.g. power loss mid-append — cannot poison future reads.
 *
 * Writes go through the `writeFile` + `rename` atomic-swap pattern used
 * by `src/permissions/settings.ts::writeJsonAtomic`: the entire
 * concatenated payload is written to a temp file (`<path>.tmp-<pid>`)
 * and renamed into place. `rename` is atomic on POSIX and on Windows
 * when both paths live on the same volume, which is the only
 * environment this file targets (`~/.agenc/` is always one directory).
 */

import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Span of one mention captured at submit time. Persisted alongside the
 * entry value so a later up-arrow recall preserves the mention metadata
 * without re-running the workspace scanner. Schema is forward-compatible:
 * old JSONL lines without `mentions` continue to read as
 * `{ ...entry, mentions: undefined }`.
 */
export interface PersistedMention {
  readonly start: number;
  readonly end: number;
  readonly kind: "file" | "skill" | "app";
  readonly resolved?: string;
}

export interface HistoryEntry {
  timestamp: number;
  value: string;
  cwd?: string;
  mentions?: readonly PersistedMention[];
}

/**
 * Relative path of the history file under the user's AgenC home. Kept
 * as a constant so callers (and tests) never have to spell it out
 * themselves.
 */
export const HISTORY_FILE_REL = join(".agenc", "history.jsonl");

function historyPath(home: string): string {
  return join(home, HISTORY_FILE_REL);
}

/**
 * Returns full `HistoryEntry` records newest-first, reading at most
 * `limit` (default 1000) entries from the tail of the file. Malformed
 * JSON lines are skipped, and a missing file returns `[]`.
 *
 * Returning `HistoryEntry[]` (rather than just `string[]`) lets recall
 * paths preserve persisted mention spans so an up-arrow rehydration can
 * skip re-scanning the workspace.
 */
export async function readHistory(
  home: string,
  limit?: number,
): Promise<HistoryEntry[]> {
  const path = historyPath(home);
  const cap = typeof limit === "number" && limit > 0 ? limit : 1000;

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return [];
    // Any other error (EACCES, EISDIR, etc.) is surfaced so callers can
    // choose how loud to be. Everyday use hits the ENOENT branch.
    throw err;
  }

  // Strip a trailing blank line so `split` doesn't yield an empty tail.
  const lines = raw.length > 0 ? raw.split("\n") : [];
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // Keep only the last `cap` lines — cheaper than parsing the whole
  // file on every read.
  const tail = lines.length > cap ? lines.slice(lines.length - cap) : lines;

  const out: HistoryEntry[] = [];
  // Walk tail-first so newest entries come out at index 0.
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i]!;
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as HistoryEntry).value === "string"
      ) {
        const entry = parsed as HistoryEntry;
        const mentions = Array.isArray(entry.mentions)
          ? (entry.mentions.filter(
              (m) =>
                m !== null &&
                typeof m === "object" &&
                typeof (m as PersistedMention).start === "number" &&
                typeof (m as PersistedMention).end === "number" &&
                typeof (m as PersistedMention).kind === "string",
            ) as readonly PersistedMention[])
          : undefined;
        out.push({
          timestamp:
            typeof entry.timestamp === "number" ? entry.timestamp : 0,
          value: entry.value,
          cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
          mentions: mentions && mentions.length > 0 ? mentions : undefined,
        });
      }
    } catch {
      // Corrupted line — silently skip.
    }
  }
  return out;
}

/**
 * Append one entry atomically. The full current file contents + the
 * new line are written to a temp file, then `rename`d into place. This
 * prevents the "torn write" race where a reader sees the first half of
 * a new line without the trailing `\n`.
 */
export async function appendHistory(
  home: string,
  entry: HistoryEntry,
): Promise<void> {
  const path = historyPath(home);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") throw err;
  }

  // Ensure the previous content ends with a newline so a stray half-
  // flushed tail doesn't accidentally fuse with the new entry.
  const prefix =
    existing.length === 0 || existing.endsWith("\n") ? existing : existing + "\n";
  const line = `${JSON.stringify(entry)}\n`;

  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, prefix + line, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);

  // `stat` once so the filesystem has a chance to flush metadata before
  // the function returns — tests that immediately re-read the file
  // benefit from this on slow filesystems.
  try {
    await stat(path);
  } catch {
    // The file definitely exists (we just wrote it) — a failing stat
    // here is a transient kernel oddity and not worth surfacing.
  }
}
