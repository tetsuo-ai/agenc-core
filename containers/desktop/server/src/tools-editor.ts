import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveValidatedTextEditorPath } from "./textEditorPath.js";
import type { ToolResult } from "./types.js";
import { ok, fail } from "./tools-shared.js";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_UNDO_FILES = 20;
const SESSION_ID_ARG = "__agencSessionId";
const LOCAL_FILE_HISTORY_MAX_ENTRIES = 8;

/** LRU undo buffer — stores the single most recent version per file. */
const undoBuffer = new Map<string, string>();
interface SessionReadSnapshot {
  readonly content?: string | null;
  readonly timestamp?: number;
}

const sessionReadState = new Map<string, Map<string, SessionReadSnapshot>>();

function numberLines(text: string, startLine = 1): string {
  return text
    .split("\n")
    .map((line, i) => `${String(i + startLine).padStart(6, " ")}\t${line}`)
    .join("\n");
}

function resolveSessionId(args: Record<string, unknown>): string | undefined {
  const value = args[SESSION_ID_ARG];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveLocalFileHistoryRoot(): string {
  const configuredRoot = process.env.AGENC_FILESYSTEM_HISTORY_ROOT?.trim();
  return configuredRoot && configuredRoot.length > 0
    ? configuredRoot
    : join(tmpdir(), "agenc", "filesystem-history");
}

function resolveLocalHistoryFilePath(sessionId: string, path: string): string {
  return join(
    resolveLocalFileHistoryRoot(),
    hashString(sessionId),
    `${hashString(path)}.json`,
  );
}

function persistLocalFileHistorySnapshot(
  sessionId: string | undefined,
  path: string,
  snapshot: SessionReadSnapshot,
): void {
  if (!sessionId || sessionId.trim().length === 0) return;
  try {
    const historyFile = resolveLocalHistoryFilePath(sessionId, path);
    mkdirSync(dirname(historyFile), { recursive: true });

    let entries: Array<SessionReadSnapshot & { readonly recordedAt: number }> = [];
    try {
      const raw = readFileSync(historyFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        entries = parsed.filter(
          (entry): entry is SessionReadSnapshot & { readonly recordedAt: number } => {
            if (typeof entry !== "object" || entry === null) return false;
            if (typeof (entry as { recordedAt?: unknown }).recordedAt !== "number") {
              return false;
            }
            const content = (entry as { content?: unknown }).content;
            return typeof content === "string" || content === null;
          },
        );
      }
    } catch {
      // Best effort only.
    }

    entries.push({
      content: snapshot.content ?? null,
      timestamp: snapshot.timestamp,
      recordedAt: Date.now(),
    });
    if (entries.length > LOCAL_FILE_HISTORY_MAX_ENTRIES) {
      entries = entries.slice(-LOCAL_FILE_HISTORY_MAX_ENTRIES);
    }
    writeFileSync(historyFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  } catch {
    // Best effort only.
  }
}

function loadPersistedSessionReadSnapshot(
  sessionId: string,
  path: string,
): SessionReadSnapshot | undefined {
  try {
    const raw = readFileSync(resolveLocalHistoryFilePath(sessionId, path), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return undefined;
    }
    for (let index = parsed.length - 1; index >= 0; index--) {
      const entry = parsed[index];
      if (typeof entry !== "object" || entry === null) continue;
      const content = (entry as { content?: unknown }).content;
      const timestampValue = (entry as { timestamp?: unknown }).timestamp;
      const recordedAtValue = (entry as { recordedAt?: unknown }).recordedAt;
      const timestamp =
        typeof timestampValue === "number" && Number.isFinite(timestampValue)
          ? timestampValue
          : typeof recordedAtValue === "number" && Number.isFinite(recordedAtValue)
            ? recordedAtValue
            : undefined;
      if (typeof content === "string") {
        return timestamp === undefined ? { content } : { content, timestamp };
      }
      if (content === null) {
        return timestamp === undefined ? { content: null } : { content: null, timestamp };
      }
    }
  } catch {
    // Best effort only.
  }
  return undefined;
}

function getSessionReadSnapshot(
  sessionId: string | undefined,
  path: string,
): SessionReadSnapshot | undefined {
  if (!sessionId || sessionId.trim().length === 0) return undefined;
  const existingSnapshot = sessionReadState.get(sessionId)?.get(path);
  if (existingSnapshot) {
    return existingSnapshot;
  }
  const persistedSnapshot = loadPersistedSessionReadSnapshot(sessionId, path);
  if (!persistedSnapshot) {
    return undefined;
  }
  let fileMap = sessionReadState.get(sessionId);
  if (!fileMap) {
    fileMap = new Map();
    sessionReadState.set(sessionId, fileMap);
  }
  fileMap.set(path, persistedSnapshot);
  return persistedSnapshot;
}

function recordSessionRead(
  sessionId: string | undefined,
  path: string,
  snapshot: SessionReadSnapshot,
): void {
  if (!sessionId || sessionId.trim().length === 0) return;
  let fileMap = sessionReadState.get(sessionId);
  if (!fileMap) {
    fileMap = new Map();
    sessionReadState.set(sessionId, fileMap);
  }
  const nextSnapshot = {
    ...(fileMap.get(path) ?? {}),
    ...snapshot,
  };
  fileMap.set(path, nextSnapshot);
  persistLocalFileHistorySnapshot(sessionId, path, nextSnapshot);
}

async function readFreshTextSnapshot(path: string): Promise<SessionReadSnapshot> {
  const [content, fileStats] = await Promise.all([
    readFile(path, "utf-8"),
    stat(path),
  ]);
  return {
    content,
    timestamp:
      typeof fileStats.mtimeMs === "number" && Number.isFinite(fileStats.mtimeMs)
        ? fileStats.mtimeMs
        : Date.now(),
  };
}

function hasFileChangedSinceSnapshot(
  snapshot: SessionReadSnapshot | undefined,
  currentContent: string,
): boolean {
  if (snapshot?.content == null) {
    return false;
  }
  return snapshot.content !== currentContent;
}

async function loadEditableFile(
  sessionId: string | undefined,
  path: string,
): Promise<{ content: string } | { error: ToolResult }> {
  const snapshot = getSessionReadSnapshot(sessionId, path);
  if (!snapshot) {
    return {
      error: fail(
        `File has not been read yet. Use view first before modifying ${path}.`,
      ),
    };
  }

  try {
    const content = await readFile(path, "utf-8");
    if (hasFileChangedSinceSnapshot(snapshot, content)) {
      return {
        error: fail(
          `File has been modified since it was last read. View ${path} again before editing it.`,
        ),
      };
    }
    return { content };
  } catch (error) {
    return {
      error: fail(`Failed to read ${path}: ${error instanceof Error ? error.message : error}`),
    };
  }
}

async function recordFreshSnapshot(sessionId: string | undefined, path: string): Promise<void> {
  const snapshot = await readFreshTextSnapshot(path);
  recordSessionRead(sessionId, path, snapshot);
}

export const __textEditorTestHooks = {
  clearSessionReadState(sessionId: string): void {
    sessionReadState.delete(sessionId);
    try {
      rmSync(join(resolveLocalFileHistoryRoot(), hashString(sessionId)), {
        recursive: true,
        force: true,
      });
    } catch {
      // Best effort only.
    }
  },
  clearSessionReadCache(sessionId: string): void {
    sessionReadState.delete(sessionId);
  },
};

export async function textEditor(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const command = args.command;
  const inputPath = args.path;

  if (typeof command !== "string" || !command) {
    return fail("command is required");
  }
  if (typeof inputPath !== "string" || !inputPath) {
    return fail("path is required");
  }

  let path: string;
  try {
    path = await resolveValidatedTextEditorPath(inputPath);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  switch (command) {
    case "view":
      return textEditorView(path, args.view_range as unknown, resolveSessionId(args));
    case "create":
      return textEditorCreate(path, String(args.file_text ?? ""), resolveSessionId(args));
    case "str_replace":
      return textEditorStrReplace(
        path,
        String(args.old_str ?? ""),
        String(args.new_str ?? ""),
        resolveSessionId(args),
      );
    case "insert":
      return textEditorInsert(
        path,
        Number(args.insert_line ?? 0),
        String(args.new_str ?? ""),
        resolveSessionId(args),
      );
    case "undo_edit":
      return textEditorUndo(path, resolveSessionId(args));
    default:
      return fail(
        `Unknown command: ${command}. Must be one of: view, create, str_replace, insert, undo_edit`,
      );
  }
}

async function textEditorView(
  path: string,
  viewRange: unknown,
  sessionId: string | undefined,
): Promise<ToolResult> {
  try {
    const s = await stat(path);
    if (s.size > MAX_FILE_SIZE) {
      return fail(`File too large (${s.size} bytes, max ${MAX_FILE_SIZE})`);
    }
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n");
    await recordFreshSnapshot(sessionId, path);

    if (viewRange && Array.isArray(viewRange) && viewRange.length === 2) {
      const start = Math.max(1, Number(viewRange[0]));
      const end = Math.min(lines.length, Number(viewRange[1]));
      if (start > end) return fail(`Invalid range: [${start}, ${end}]`);
      const slice = lines.slice(start - 1, end);
      return ok({ output: numberLines(slice.join("\n"), start) });
    }

    return ok({ output: numberLines(content) });
  } catch (e) {
    return fail(`Failed to read ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

async function textEditorCreate(
  path: string,
  fileText: string,
  sessionId: string | undefined,
): Promise<ToolResult> {
  try {
    try {
      const existing = await stat(path);
      if (existing.isFile()) {
        return fail(`File already exists at ${path}. Use view plus str_replace/insert instead of create.`);
      }
      return fail(`Path already exists at ${path}.`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fileText, "utf-8");
    await recordFreshSnapshot(sessionId, path);
    return ok({ output: `File created at ${path} (${fileText.split("\n").length} lines)` });
  } catch (e) {
    return fail(`Failed to create ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

async function textEditorStrReplace(
  path: string,
  oldStr: string,
  newStr: string,
  sessionId: string | undefined,
): Promise<ToolResult> {
  if (!oldStr) return fail("old_str is required for str_replace");

  try {
    const loaded = await loadEditableFile(sessionId, path);
    if ("error" in loaded) {
      return loaded.error;
    }
    const content = loaded.content;
    const occurrences = content.split(oldStr).length - 1;

    if (occurrences === 0) {
      return fail(
        `old_str not found in ${path}. Make sure the string matches exactly, including whitespace.`,
      );
    }
    if (occurrences > 1) {
      return fail(
        `old_str found ${occurrences} times in ${path}. Provide more context to make it unique.`,
      );
    }

    // Save undo state (LRU eviction)
    if (undoBuffer.size >= MAX_UNDO_FILES && !undoBuffer.has(path)) {
      const oldest = undoBuffer.keys().next().value as string;
      undoBuffer.delete(oldest);
    }
    undoBuffer.delete(path); // Re-insert at end for LRU
    undoBuffer.set(path, content);

    const updated = content.replace(oldStr, newStr);
    await writeFile(path, updated, "utf-8");
    await recordFreshSnapshot(sessionId, path);
    return ok({ output: `Replacement applied in ${path}` });
  } catch (e) {
    return fail(`str_replace failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function textEditorInsert(
  path: string,
  insertLine: number,
  newStr: string,
  sessionId: string | undefined,
): Promise<ToolResult> {
  try {
    const loaded = await loadEditableFile(sessionId, path);
    if ("error" in loaded) {
      return loaded.error;
    }
    const content = loaded.content;
    const lines = content.split("\n");

    if (insertLine < 0 || insertLine > lines.length) {
      return fail(
        `insert_line ${insertLine} out of range (0-${lines.length}). Use 0 to insert at the beginning.`,
      );
    }

    // Save undo state (LRU eviction)
    if (undoBuffer.size >= MAX_UNDO_FILES && !undoBuffer.has(path)) {
      const oldest = undoBuffer.keys().next().value as string;
      undoBuffer.delete(oldest);
    }
    undoBuffer.delete(path);
    undoBuffer.set(path, content);

    const newLines = newStr.split("\n");
    lines.splice(insertLine, 0, ...newLines);
    await writeFile(path, lines.join("\n"), "utf-8");
    await recordFreshSnapshot(sessionId, path);
    return ok({
      output: `Inserted ${newLines.length} line(s) after line ${insertLine} in ${path}`,
    });
  } catch (e) {
    return fail(`insert failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function textEditorUndo(
  path: string,
  sessionId: string | undefined,
): Promise<ToolResult> {
  const prev = undoBuffer.get(path);
  if (prev === undefined) {
    return fail(`No undo history for ${path}`);
  }
  try {
    const loaded = await loadEditableFile(sessionId, path);
    if ("error" in loaded) {
      return loaded.error;
    }
    await writeFile(path, prev, "utf-8");
    await recordFreshSnapshot(sessionId, path);
    undoBuffer.delete(path);
    return ok({ output: `Reverted ${path} to previous version` });
  } catch (e) {
    return fail(`undo_edit failed: ${e instanceof Error ? e.message : e}`);
  }
}
