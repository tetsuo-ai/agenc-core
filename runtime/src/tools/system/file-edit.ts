/**
 * `Edit` — first-class string-replacement editor.
 *
 * Lifted from AgenC `FileEditTool` (src/tools/FileEditTool/*) and
 * adapted to the AgenC tool contract. Behavior summary:
 *
 *   - Read-before-write enforcement via {@link hasSessionRead}. The
 *     model must have called the AgenC read tool on the path with a
 *     full view earlier in the session, otherwise the edit is rejected
 *     with the verbatim AgenC error string.
 *   - Modification-time check: if the file mtime advanced past the
 *     recorded read snapshot, the edit is rejected with AgenC's
 *     "modified since read" error so the model is forced to re-read.
 *   - Empty-old_string semantics:
 *       * empty + nonexistent path  → create empty target
 *       * empty + existing nonempty → reject ("file already exists")
 *       * empty + existing empty    → accept
 *   - `replace_all`: when true, every occurrence is replaced; when false
 *     a multi-match is rejected with an actionable error.
 *   - Quote/typography normalization via {@link findActualString} —
 *     verbatim port from AgenC utils.ts. Smart quotes, en/em dashes,
 *     and NBSP normalize so a model can match against typographic prose.
 *   - `old_string === new_string` is rejected with the verbatim
 *     AgenC error.
 *   - `.ipynb` files are rejected with a notebook-tool hint.
 *
 * Errors are returned as plain text in `ToolResult.content` with
 * `isError: true` — no JSON envelope, matching the AgenC-style envelope
 * used elsewhere in AgenC's tool surface.
 *
 * @module
 */

import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type {
  Tool,
  ToolExecutionInjectedArgs,
  ToolResult,
} from "../types.js";
import {
  getSessionReadSnapshot,
  hasSessionRead,
  recordSessionRead,
  resolveSessionId,
  safePathAllowingSessionPlanFile,
} from "./filesystem.js";

export const FILE_EDIT_TOOL_NAME = "Edit";

const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

const READ_BEFORE_WRITE_ERROR =
  "File has not been read yet. Read it first before writing to it.";

// Verbatim from AgenC FileEditTool/prompt.ts:20-27.
const FILE_EDIT_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`;

// V8/Bun string length cap. 1 GiB stat-size guard prevents OOM on
// gigabyte files. Lifted from AgenC FileEditTool.ts:84.
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024;

// ── quote normalization (lifted from AgenC utils.ts) ─────────────

const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";

// Em-dash, en-dash, and other Unicode dashes that often appear in copy
// from typography-aware editors. Normalized to ASCII `-` so a model
// pasting straight ASCII can still match.
const UNICODE_DASH_RE = /[‐‑‒–—―−]/gu;
// NBSP and friends. Normalized to ASCII space.
const UNICODE_SPACE_RE = /[  -   　]/gu;

/**
 * Normalize curly quotes, Unicode dashes, and exotic spaces to their
 * ASCII equivalents. Lifted from AgenC `utils.ts` `normalizeQuotes`,
 * extended with dash/space passes so a model whose `old_string` is
 * pure ASCII can still match against typographic file content.
 */
function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
    .replace(UNICODE_DASH_RE, "-")
    .replace(UNICODE_SPACE_RE, " ");
}

/**
 * Verbatim port of AgenC `utils.ts:findActualString`. When
 * `searchString` is not literally present in `fileContent`, retry with
 * a quote/dash/space-normalized comparison and return the actual byte
 * range from the file at the matching offset.
 *
 * Returns `null` when no match exists under either pass.
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) {
    return searchString;
  }
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const idx = normalizedFile.indexOf(normalizedSearch);
  if (idx < 0) return null;
  return fileContent.substring(idx, idx + searchString.length);
}

// ── tool config / errors ──────────────────────────────────────────────

export interface FileEditToolConfig {
  /** Allowed path prefixes (required). */
  readonly allowedPaths: readonly string[];
}

function errorResult(message: string): ToolResult {
  return { content: message, isError: true };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface EditArgs extends ToolExecutionInjectedArgs {
  readonly file_path?: unknown;
  readonly old_string?: unknown;
  readonly new_string?: unknown;
  readonly replace_all?: unknown;
}

interface ResolvedEditInputs {
  readonly file_path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
}

function validateInputs(
  args: EditArgs,
): ResolvedEditInputs | { error: string } {
  const filePath = asNonEmptyString(args.file_path);
  if (!filePath) {
    return { error: "file_path must be a non-empty string" };
  }
  const oldString = asString(args.old_string);
  if (oldString === undefined) {
    return { error: "old_string must be a string" };
  }
  const newString = asString(args.new_string);
  if (newString === undefined) {
    return { error: "new_string must be a string" };
  }
  return {
    file_path: filePath,
    old_string: oldString,
    new_string: newString,
    replace_all: args.replace_all === true,
  };
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly content: string;
  readonly mtimeMs: number;
  readonly size: number;
}

async function readFileSnapshot(absolutePath: string): Promise<FileSnapshot> {
  try {
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) {
      throw new Error(`Path is not a regular file: ${absolutePath}`);
    }
    const buffer = await readFile(absolutePath);
    // Normalize CRLF→LF the same way AgenC FileEditTool.ts:214 does;
    // the model authoring `old_string` against Read output sees LF.
    const text = buffer.toString("utf8").replaceAll("\r\n", "\n");
    return {
      exists: true,
      content: text,
      mtimeMs:
        typeof fileStats.mtimeMs === "number" && Number.isFinite(fileStats.mtimeMs)
          ? fileStats.mtimeMs
          : 0,
      size: fileStats.size,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { exists: false, content: "", mtimeMs: 0, size: 0 };
    }
    throw err;
  }
}

async function writeFileCreatingParents(
  absolutePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

/**
 * Record the post-write content as the session's view of the file so the
 * per-turn changed-files attachment producer
 * (`runtime/src/prompts/attachments/changed-files.ts`) does not fire a
 * spurious diff on the next turn for the file we just wrote.
 *
 * Best-effort — a failed stat falls back to wall-clock time, and a
 * missing sessionId is a no-op (matches AgenC's
 * `recordOnDiskWriteForFreshState` defensive shape).
 */
async function snapshotPostWrite(
  sessionId: string | undefined,
  absolutePath: string,
  content: string,
): Promise<void> {
  if (sessionId === undefined) return;
  let mtimeMs: number = Date.now();
  try {
    const post = await stat(absolutePath);
    if (Number.isFinite(post.mtimeMs)) mtimeMs = post.mtimeMs;
  } catch {
    // Fall back to wall clock.
  }
  recordSessionRead(sessionId, absolutePath, {
    content,
    rawContent: content,
    timestamp: mtimeMs,
    viewKind: "full",
  });
}

function applyEdit(
  fileContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (replaceAll) {
    return fileContent.split(oldString).join(newString);
  }
  return fileContent.replace(oldString, newString);
}

/**
 * Format a successful-edit result line. Mirrors AgenC
 * `mapToolResultToToolResultBlockParam` (FileEditTool.ts:578-597),
 * adapted for AgenC's plain-text content envelope.
 */
function successText(filePath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${filePath} has been updated. All occurrences were successfully replaced.`
    : `The file ${filePath} has been updated successfully.`;
}

export function createFileEditTool(config: FileEditToolConfig): Tool {
  return {
    name: FILE_EDIT_TOOL_NAME,
    description: FILE_EDIT_DESCRIPTION,
    metadata: {
      family: "filesystem",
      source: "builtin",
      keywords: ["edit", "replace", "string", "patch"],
      preferredProfiles: ["coding"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
    },
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Absolute or workspace-relative path to the file to edit.",
        },
        old_string: {
          type: "string",
          description:
            "The exact text to replace. Must match a unique substring of the file unless replace_all is true.",
        },
        new_string: {
          type: "string",
          description: "The replacement text.",
        },
        replace_all: {
          type: "boolean",
          description:
            "Optional. When true, replace every occurrence of old_string. Defaults to false.",
        },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as EditArgs;
      const validated = validateInputs(args);
      if ("error" in validated) return errorResult(validated.error);
      const { file_path, old_string, new_string, replace_all } = validated;

      // Verbatim from AgenC FileEditTool.ts:148-156.
      if (old_string === new_string) {
        return errorResult(
          "No changes to make: old_string and new_string are exactly the same.",
        );
      }

      // Resolve relative paths against the first allowed root before
      // safePath so a workspace-relative `src/foo.ts` is accepted by
      // the same allowlist that absolute paths run through.
      const candidatePath = isAbsolute(file_path)
        ? file_path
        : resolve(
            asNonEmptyString(rawArgs.cwd) ?? config.allowedPaths[0] ?? process.cwd(),
            file_path,
          );

      // For nonexistent paths, safePath() canonicalizes the deepest
      // existing parent — so creation under an allowed root still
      // resolves correctly. Same trick filesystem.ts uses for
      // writeFile creates.
      const safe = await safePathAllowingSessionPlanFile(
        candidatePath,
        config.allowedPaths,
        rawArgs,
      );
      if (!safe.safe) {
        return errorResult(`Access denied: ${safe.reason}`);
      }
      const absoluteFilePath = safe.resolved;

      // Reject .ipynb. AgenC has no notebook tool today, but pointing
      // the model at a "notebook-specific tool" still saves it from
      // corrupting the JSON envelope of an ipynb with raw text edits.
      if (absoluteFilePath.endsWith(".ipynb")) {
        return errorResult(
          "File is a Jupyter Notebook. Use a notebook-specific tool to edit Jupyter notebooks.",
        );
      }

      // Snapshot the file (or note it's missing). All later branching
      // depends on this single read so the post-validation write race
      // window is minimized.
      let snapshot: FileSnapshot;
      try {
        snapshot = await readFileSnapshot(absoluteFilePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to read file: ${message}`);
      }

      // OOM guard.
      if (snapshot.exists && snapshot.size > MAX_EDIT_FILE_SIZE) {
        return errorResult(
          `File is too large to edit (${snapshot.size} bytes). Maximum editable file size is ${MAX_EDIT_FILE_SIZE} bytes.`,
        );
      }

      // Empty old_string + nonexistent file → file creation.
      // Verbatim semantics from AgenC FileEditTool.ts:223-228.
      if (!snapshot.exists && old_string === "") {
        try {
          await writeFileCreatingParents(absoluteFilePath, new_string);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(`Failed to create file: ${message}`);
        }
        await snapshotPostWrite(
          resolveSessionId(rawArgs),
          absoluteFilePath,
          new_string,
        );
        return { content: `Created file ${file_path}.` };
      }

      // Nonexistent file with non-empty old_string → error. The hint
      // is intentionally simpler than AgenC's "did you mean X?"
      // suggestion — that path needed cwd-aware fuzzy file lookup
      // helpers we don't have wired into this tool yet.
      if (!snapshot.exists) {
        return errorResult(
          `File does not exist: ${file_path}. To create a new file, pass an empty old_string.`,
        );
      }

      // File exists + empty old_string. Verbatim from FileEditTool.ts:248-264.
      if (old_string === "") {
        if (snapshot.content.trim() !== "") {
          return errorResult("Cannot create new file - file already exists.");
        }
        // Empty file + empty old_string → write new_string.
        try {
          await writeFile(absoluteFilePath, new_string, "utf8");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(`Failed to write file: ${message}`);
        }
        await snapshotPostWrite(
          resolveSessionId(rawArgs),
          absoluteFilePath,
          new_string,
        );
        return { content: successText(file_path, false) };
      }

      // Read-before-write enforcement. User-initiated `FileRead`
      // calls satisfy the gate even when they use offset/limit, matching
      // AgenC's gate semantics. AgenC does not currently seed
      // auto-injected processed content into this state.
      //
      // Skipped when no sessionId was injected (headless / unit-test
      // path) so unit tests don't have to fake a session lifecycle.
      const sessionId = resolveSessionId(rawArgs);
      if (sessionId !== undefined) {
        if (!hasSessionRead(sessionId, absoluteFilePath)) {
          return errorResult(READ_BEFORE_WRITE_ERROR);
        }
      }

      // Modification-time staleness check. We compare the file's
      // current mtime against the snapshot we recorded at read time.
      // The session-read tracker stores mtime in `timestamp`; if that
      // timestamp is older than the current mtime, an external mutation
      // happened and the model's `old_string` may be stale.
      if (sessionId !== undefined) {
        const recordedSnapshot = getSessionReadSnapshot(
          sessionId,
          absoluteFilePath,
        );
        const recordedTs = recordedSnapshot?.timestamp;
        if (
          typeof recordedTs === "number" &&
          Number.isFinite(recordedTs) &&
          snapshot.mtimeMs > recordedTs
        ) {
          // Windows cloud-sync false-positive guard, lifted from
          // FileEditTool.ts:296-300: when the recorded full content
          // matches the current file content, treat the mtime bump
          // as a benign touch.
          const isFullContentMatch =
            recordedSnapshot?.viewKind === "full" &&
            typeof recordedSnapshot.content === "string" &&
            recordedSnapshot.content === snapshot.content;
          if (!isFullContentMatch) {
            return errorResult(FILE_UNEXPECTEDLY_MODIFIED_ERROR);
          }
        }
      }

      // Quote/typography normalization. After this pass, `actualOldString`
      // is the literal substring present in the file (possibly with
      // smart quotes / Unicode dashes) that corresponds to the model's
      // ASCII `old_string`.
      const actualOldString = findActualString(snapshot.content, old_string);
      if (actualOldString === null) {
        return errorResult(
          `String to replace not found in file.\nString: ${old_string}`,
        );
      }

      // Match counting with early-out for non-replace_all calls. Mirrors
      // AgenC FileEditTool.ts:329-343.
      let matches = 0;
      let from = 0;
      while (true) {
        const idx = snapshot.content.indexOf(actualOldString, from);
        if (idx < 0) break;
        matches += 1;
        from = idx + actualOldString.length;
        if (!replace_all && matches > 1) break;
      }
      if (matches === 0) {
        // findActualString found a match but indexOf says no — this is
        // unreachable in practice but the defensive check matches the
        // AgenC error wording so a model that hits the path gets
        // the same recovery hint.
        return errorResult(
          `String to replace not found in file.\nString: ${old_string}`,
        );
      }
      if (!replace_all && matches > 1) {
        return errorResult(
          `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
        );
      }

      // Compute new content and write.
      const updated = applyEdit(
        snapshot.content,
        actualOldString,
        new_string,
        replace_all,
      );
      try {
        await writeFile(absoluteFilePath, updated, "utf8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to write file: ${message}`);
      }

      await snapshotPostWrite(sessionId, absoluteFilePath, updated);

      // TODO(file-edit): wire LSP didChange/didSave notifications when
      // AgenC adds an LSP integration. AgenC's FileEditTool.ts:493-514
      // emits both events for incremental diagnostics; AgenC has no
      // LSP today so nothing to notify.

      return { content: successText(file_path, replace_all) };
    },
  };
}

export default createFileEditTool;
