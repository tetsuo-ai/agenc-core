/**
 * `Edit` / `MultiEdit` — first-class string-replacement editors.
 *
 * Lifted from the upstream file-edit tool and
 * adapted to the AgenC tool contract. Behavior summary:
 *
 *   - Read-before-write enforcement via {@link isAuthorizingSessionRead}.
 *     The model must have called the AgenC read tool on the path earlier
 *     in the session — a full OR partial offset/limit read authorizes the
 *     edit; only an absent read or a synthetic partial view is rejected
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
 *   - Quote normalization via {@link findActualString} — verbatim port from
 *     AgenC utils.ts. Smart quotes normalize so a model can match against
 *     typographic prose; dashes and non-ASCII spaces remain exact.
 *   - `old_string === new_string` is rejected with the verbatim
 *     AgenC error.
 *   - `.ipynb` files are rejected with a notebook-tool hint.
 *   - MultiEdit validates every operation against the in-memory result
 *     of previous operations, then writes once so failed batches leave
 *     the file untouched.
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
import { plainTextErrorToolResult as errorResult } from "../results.js";
import { buildFileMutationMetadata } from "../result-metadata.js";
import {
  getSessionReadSnapshot,
  recordSessionRead,
  resolveSessionId,
  safePathAllowingSessionPlanFile,
} from "./filesystem.js";
import {
  agentNamespacePathHint,
  denyAgentNamespacePath,
  isAgentNamespacePath,
} from "./agent-path-hints.js";
import { checkToolPathPermission } from "../../permissions/path-validation.js";
import { notifyLspFileChanged } from "../../services/lsp/fileNotifications.js";
import { nonEmptyString as asNonEmptyString } from "../../utils/stringUtils.js";

export const FILE_EDIT_TOOL_NAME = "Edit";
export const FILE_MULTI_EDIT_TOOL_NAME = "MultiEdit";

const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

const READ_BEFORE_WRITE_ERROR =
  "File has not been read yet. Read it first before writing to it.";

const SESSION_ID_MISSING_ERROR =
  "file_edit was invoked without a session id. The runtime injects this automatically; if you are calling the tool from a unit test, pass __testBypassSessionGuard:true to opt out of read-before-write enforcement.";

/**
 * Test-only opt-out of the read-before-write session guard. Production
 * callers must NEVER set this — the canonical tool surface
 * (canonicalToolSurface.ts) injects SESSION_ID_ARG automatically via
 * getSessionId(). Tests that exercise the tool at the execute boundary
 * without spinning up a full session lifecycle can pass
 * `__testBypassSessionGuard:true`.
 *
 * Defense in depth: the flag is ONLY honored when NODE_ENV === "test".
 * The runtime's tool-call dispatch path does not enforce the JSON
 * schema's `additionalProperties: false`, so a malicious model could
 * include this arg key and reach `tool.execute(args)` with the flag
 * set. Gating on NODE_ENV closes that vector — in production builds
 * the flag is always treated as absent regardless of what the model
 * sends.
 *
 * The previous behavior silently skipped the read-before-write check
 * whenever sessionId was undefined, which masked any production code
 * path that lost the session id (e.g., a future SDK consumer that
 * bypasses canonicalToolSurface). Failing loud is safer.
 */
const TEST_BYPASS_SESSION_GUARD_ARG = "__testBypassSessionGuard";

function shouldBypassSessionGuard(args: Record<string, unknown>): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  return args[TEST_BYPASS_SESSION_GUARD_ARG] === true;
}

// Verbatim from AgenC FileEditTool/prompt.ts:20-27.
const FILE_EDIT_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- Use workspace-relative paths like \`game.py\` unless the user provided a real absolute path. Do not use \`/root/...\`; \`/root\` is the agent namespace, not the filesystem.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`;

const FILE_MULTI_EDIT_DESCRIPTION = `Performs multiple exact string replacements in a single file.

Usage:
- Use this tool when you need to make several coordinated edits to the same file.
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- Use workspace-relative paths like \`game.py\` unless the user provided a real absolute path. Do not use \`/root/...\`; \`/root\` is the agent namespace, not the filesystem.
- Each edit is applied in order to the result of the previous edit.
- The file is only written after every edit validates successfully. If any edit fails, the file is left unchanged.
- The edit will FAIL if any \`old_string\` is not unique in the file at the time that edit is applied. Either provide more surrounding context or set \`replace_all\` to true for that edit.
- Use \`replace_all\` for replacing and renaming strings across the file.`;

// V8/Bun string length cap. 1 GiB stat-size guard prevents OOM on
// gigabyte files. Lifted from the upstream file-edit guard.
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024;

// ── quote normalization (lifted from AgenC utils.ts) ─────────────

const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";

/**
 * Normalize curly quotes to their ASCII equivalents. Lifted from the
 * upstream `normalizeQuotes` helper.
 */
function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

/**
 * Verbatim port of the upstream `findActualString` helper. When
 * `searchString` is not literally present in `fileContent`, retry with
 * a quote-normalized comparison and return the actual byte range from
 * the file at the matching offset.
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

function isOpeningQuoteContext(chars: readonly string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return (
    prev === " " ||
    prev === "\t" ||
    prev === "\n" ||
    prev === "\r" ||
    prev === "(" ||
    prev === "[" ||
    prev === "{" ||
    prev === "—" ||
    prev === "–"
  );
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str];
  return chars
    .map((char, index) => {
      if (char !== '"') return char;
      return isOpeningQuoteContext(chars, index)
        ? LEFT_DOUBLE_CURLY_QUOTE
        : RIGHT_DOUBLE_CURLY_QUOTE;
    })
    .join("");
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str];
  return chars
    .map((char, index) => {
      if (char !== "'") return char;
      const prev = index > 0 ? chars[index - 1] : undefined;
      const next = index < chars.length - 1 ? chars[index + 1] : undefined;
      const isContraction =
        prev !== undefined &&
        next !== undefined &&
        /\p{L}/u.test(prev) &&
        /\p{L}/u.test(next);
      if (isContraction) return RIGHT_SINGLE_CURLY_QUOTE;
      return isOpeningQuoteContext(chars, index)
        ? LEFT_SINGLE_CURLY_QUOTE
        : RIGHT_SINGLE_CURLY_QUOTE;
    })
    .join("");
}

function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) return newString;

  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);
  if (!hasDoubleQuotes && !hasSingleQuotes) return newString;

  let result = newString;
  if (hasDoubleQuotes) result = applyCurlyDoubleQuotes(result);
  if (hasSingleQuotes) result = applyCurlySingleQuotes(result);
  return result;
}

// ── tool config / errors ──────────────────────────────────────────────

export interface FileEditToolConfig {
  /** Allowed path prefixes (required). */
  readonly allowedPaths: readonly string[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface EditArgs extends ToolExecutionInjectedArgs {
  readonly file_path?: unknown;
  readonly old_string?: unknown;
  readonly new_string?: unknown;
  readonly replace_all?: unknown;
  readonly cwd?: unknown;
}

interface MultiEditArgs extends ToolExecutionInjectedArgs {
  readonly file_path?: unknown;
  readonly edits?: unknown;
  readonly cwd?: unknown;
}

interface ResolvedEditInputs {
  readonly file_path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
}

interface ResolvedMultiEdit {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
}

interface ResolvedMultiEditInputs {
  readonly file_path: string;
  readonly edits: readonly ResolvedMultiEdit[];
}

type LineEndingType = "CRLF" | "LF";

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

function validateMultiEditInputs(
  args: MultiEditArgs,
): ResolvedMultiEditInputs | { error: string } {
  const filePath = asNonEmptyString(args.file_path);
  if (!filePath) {
    return { error: "file_path must be a non-empty string" };
  }
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    return { error: "edits must be a non-empty array" };
  }

  const edits: ResolvedMultiEdit[] = [];
  for (let i = 0; i < args.edits.length; i += 1) {
    const edit = args.edits[i];
    if (edit === null || typeof edit !== "object" || Array.isArray(edit)) {
      return { error: `edits[${i}] must be an object` };
    }
    const rawEdit = edit as Record<string, unknown>;
    const oldString = asString(rawEdit.old_string);
    if (oldString === undefined) {
      return { error: `edits[${i}].old_string must be a string` };
    }
    const newString = asString(rawEdit.new_string);
    if (newString === undefined) {
      return { error: `edits[${i}].new_string must be a string` };
    }
    if (
      rawEdit.replace_all !== undefined &&
      typeof rawEdit.replace_all !== "boolean"
    ) {
      return {
        error: `edits[${i}].replace_all must be a boolean when provided`,
      };
    }
    edits.push({
      old_string: oldString,
      new_string: newString,
      replace_all: rawEdit.replace_all === true,
    });
  }

  return { file_path: filePath, edits };
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly content: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly encoding: BufferEncoding;
  readonly lineEndings: LineEndingType;
}

function detectEncoding(buffer: Buffer): BufferEncoding {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    ? "utf16le"
    : "utf8";
}

function detectLineEndings(content: string): LineEndingType {
  let crlfCount = 0;
  let lfCount = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== "\n") continue;
    if (i > 0 && content[i - 1] === "\r") crlfCount += 1;
    else lfCount += 1;
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}

function encodeForOriginalFormat(
  content: string,
  lineEndings: LineEndingType,
): string {
  if (lineEndings !== "CRLF") return content;
  return content.replaceAll("\r\n", "\n").split("\n").join("\r\n");
}

async function readFileSnapshot(absolutePath: string): Promise<FileSnapshot> {
  try {
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) {
      throw new Error(`Path is not a regular file: ${absolutePath}`);
    }
    const buffer = await readFile(absolutePath);
    const encoding = detectEncoding(buffer);
    const rawText = buffer.toString(encoding);
    // Normalize CRLF→LF for matching because Read output is LF-normalized,
    // but retain the original format for the final write.
    const text = rawText.replaceAll("\r\n", "\n");
    return {
      exists: true,
      content: text,
      mtimeMs:
        typeof fileStats.mtimeMs === "number" && Number.isFinite(fileStats.mtimeMs)
          ? fileStats.mtimeMs
          : 0,
      size: fileStats.size,
      encoding,
      lineEndings: detectLineEndings(rawText),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return {
        exists: false,
        content: "",
        mtimeMs: 0,
        size: 0,
        encoding: "utf8",
        lineEndings: "LF",
      };
    }
    throw err;
  }
}

function comparableSessionContent(
  snapshot: ReturnType<typeof getSessionReadSnapshot>,
): string | undefined {
  const content =
    typeof snapshot?.rawContent === "string"
      ? snapshot.rawContent
      : snapshot?.content;
  return typeof content === "string"
    ? content.replaceAll("\r\n", "\n")
    : undefined;
}

/**
 * Read-before-write authorization predicate. ANY real read of the path —
 * full OR partial offset/limit window — authorizes a subsequent edit; the
 * gate only exists to force the model to observe real bytes before
 * mutating. We reject only when no snapshot exists at all, or when the
 * snapshot is a SYNTHETIC partial view (`isPartialView === true`), which is
 * an auto-injected processed view that never reflected real disk bytes the
 * model chose to read. This mirrors {@link hasSessionRead}. The separate
 * mtime-staleness check below still independently rejects stale edits.
 */
function isAuthorizingSessionRead(
  snapshot: ReturnType<typeof getSessionReadSnapshot>,
): boolean {
  return snapshot !== undefined && snapshot.isPartialView !== true;
}

async function writeFileCreatingParents(
  absolutePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

/**
 * Sentinel thrown by writeFilePreservingSnapshot when the on-disk
 * mtime advanced between the snapshot read and the write. The caller
 * surfaces this as a clean error result so the model knows the edit
 * was rejected because of a concurrent modification, NOT a transient
 * I/O failure.
 */
class ConcurrentFileModificationError extends Error {
  readonly code = "concurrent_file_modification" as const;
  constructor(public readonly path: string) {
    super(
      `${path} was modified between snapshot read and write — refusing to overwrite to avoid silent data loss.`,
    );
    this.name = "ConcurrentFileModificationError";
  }
}

/**
 * Convert any thrown error from a writeFilePreservingSnapshot call
 * into a model-facing error message. Concurrent-modification errors
 * get a specific recovery hint (re-Read the file); other errors fall
 * through to the generic "Failed to write file" prefix.
 */
function formatWriteFileError(err: unknown): string {
  if (err instanceof ConcurrentFileModificationError) {
    return [
      `${err.path} was modified by another writer between Read and Edit.`,
      "The edit was rejected to prevent silent data loss.",
      "Re-Read the file to refresh its contents, then retry the edit.",
    ].join(" ");
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Failed to write file: ${message}`;
}

async function writeFilePreservingSnapshot(
  absolutePath: string,
  content: string,
  snapshot: FileSnapshot,
): Promise<void> {
  // Re-stat immediately before the write to detect concurrent edits
  // that landed between the snapshot read and now. This narrows the
  // TOCTOU window to a single syscall pair (stat then write). It is
  // not bulletproof — a writer that sneaks in between the stat and
  // the writeFile syscall here would still race — but it eliminates
  // the multi-await window where the runtime did a snapshot, then a
  // session-cache lookup, then an mtime check, then validate edit,
  // then write, all interleaved with other awaits.
  //
  // Skipped for non-existing files (snapshot.exists === false) because
  // the caller routes those through writeFileCreatingParents instead;
  // this codepath is for "edit an existing file we just snapshotted."
  if (snapshot.exists) {
    try {
      const current = await stat(absolutePath);
      if (
        typeof current.mtimeMs === "number" &&
        Number.isFinite(current.mtimeMs) &&
        current.mtimeMs > snapshot.mtimeMs
      ) {
        throw new ConcurrentFileModificationError(absolutePath);
      }
    } catch (err) {
      if (err instanceof ConcurrentFileModificationError) throw err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // File was deleted between snapshot and write — treat as
        // concurrent modification.
        throw new ConcurrentFileModificationError(absolutePath);
      }
      // Unexpected stat failure — fall through and let writeFile
      // surface the underlying error.
    }
  }
  await writeFile(
    absolutePath,
    encodeForOriginalFormat(content, snapshot.lineEndings),
    snapshot.encoding,
  );
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
): { updated: string; replacements: number } {
  let search = oldString;
  // Donor parity: deleting a string that appears before a newline removes
  // that following newline too. This is deliberately substring-based, so
  // inline `oldString + "\n"` matches join the surrounding lines.
  const stripTrailingNewline =
    newString === "" &&
    !oldString.endsWith("\n") &&
    fileContent.includes(`${oldString}\n`);
  if (stripTrailingNewline) search = `${oldString}\n`;

  const updated = replaceAll
    ? fileContent.replaceAll(search, () => newString)
    : fileContent.replace(search, () => newString);
  return {
    updated,
    replacements: countReplacementOccurrences(fileContent, search, replaceAll),
  };
}

function countReplacementOccurrences(
  fileContent: string,
  search: string,
  replaceAll: boolean,
): number {
  if (search === "") return 0;
  if (!replaceAll) return fileContent.includes(search) ? 1 : 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = fileContent.indexOf(search, from);
    if (idx < 0) return count;
    count += 1;
    from = idx + search.length;
  }
}

function applyValidatedEdit(
  fileContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { updated: string; replacements: number } | { error: string } {
  const actualOldString = findActualString(fileContent, oldString);
  if (actualOldString === null) {
    return {
      error: `String to replace not found in file.\nString: ${oldString}`,
    };
  }

  let matches = 0;
  let from = 0;
  while (true) {
    const idx = fileContent.indexOf(actualOldString, from);
    if (idx < 0) break;
    matches += 1;
    from = idx + actualOldString.length;
    if (!replaceAll && matches > 1) break;
  }
  if (matches === 0) {
    return {
      error: `String to replace not found in file.\nString: ${oldString}`,
    };
  }
  if (!replaceAll && matches > 1) {
    return {
      error: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`,
    };
  }

  const actualNewString = preserveQuoteStyle(
    oldString,
    actualOldString,
    newString,
  );

  const applied = applyEdit(fileContent, actualOldString, actualNewString, replaceAll);
  if (applied.updated === fileContent) {
    return {
      error: "No changes to make: old_string and new_string are exactly the same.",
    };
  }
  return applied;
}

/**
 * Format a successful-edit result line. Mirrors the upstream
 * tool-result mapper,
 * adapted for AgenC's plain-text content envelope.
 */
function successText(filePath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${filePath} has been updated. All occurrences were successfully replaced.`
    : `The file ${filePath} has been updated successfully.`;
}

function multiEditSuccessText(
  filePath: string,
  edits: number,
  replacements: number,
): string {
  const editLabel = edits === 1 ? "edit" : "edits";
  const replacementLabel = replacements === 1 ? "replacement" : "replacements";
  return `The file ${filePath} has been updated successfully. ${edits} ${editLabel} applied with ${replacements} ${replacementLabel}.`;
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
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Workspace-relative path, or a real absolute filesystem path. Do not use /root; that is the agent namespace.",
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
    checkPermissions(input, context) {
      const args = input as EditArgs;
      const filePath = asNonEmptyString(args.file_path);
      if (!filePath) {
        return {
          behavior: "ask",
          message: "file_path must be a non-empty string",
        };
      }
      const cwd =
        asNonEmptyString(args.cwd) ?? config.allowedPaths[0] ?? process.cwd();
      if (isAgentNamespacePath(filePath)) {
        return denyAgentNamespacePath(filePath, cwd);
      }
      return checkToolPathPermission({
        toolName: FILE_EDIT_TOOL_NAME,
        input: input as Record<string, unknown>,
        path: filePath,
        cwd,
        context: context.getAppState().toolPermissionContext,
        operationType: asString(args.old_string) === "" ? "create" : "write",
        extraWorkingDirectories: config.allowedPaths,
      });
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
      const cwd =
        asNonEmptyString(rawArgs.cwd) ?? config.allowedPaths[0] ?? process.cwd();
      if (isAgentNamespacePath(file_path)) {
        return errorResult(agentNamespacePathHint(file_path, cwd));
      }
      const candidatePath = isAbsolute(file_path)
        ? file_path
        : resolve(cwd, file_path);

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
        notifyLspFileChanged(absoluteFilePath, new_string);
        return {
          content: `Created file ${file_path}.`,
          metadata: buildFileMutationMetadata({
            filePath: file_path,
            operation: "create",
            beforeText: "",
            afterText: new_string,
          }),
        };
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

      // Read-before-write enforcement. Existing files require a real read
      // snapshot — a full OR partial offset/limit read authorizes the edit;
      // only an absent read or a synthetic partial view is rejected.
      //
      // Production callers MUST inject a session id via SESSION_ID_ARG
      // (canonicalToolSurface.ts:mapCanonicalInput does this from
      // getSessionId() automatically). The previous behavior silently
      // skipped this check when sessionId was undefined, which masked
      // any production path that lost the session id. Tests can opt
      // out explicitly via __testBypassSessionGuard:true.
      const sessionId = resolveSessionId(rawArgs);
      const bypassSessionGuard = shouldBypassSessionGuard(rawArgs);
      let recordedSnapshot: ReturnType<typeof getSessionReadSnapshot> =
        undefined;
      if (sessionId !== undefined) {
        recordedSnapshot = getSessionReadSnapshot(sessionId, absoluteFilePath);
        if (!isAuthorizingSessionRead(recordedSnapshot)) {
          return errorResult(READ_BEFORE_WRITE_ERROR);
        }
      } else if (!bypassSessionGuard) {
        return errorResult(SESSION_ID_MISSING_ERROR);
      }

      // Modification-time staleness check. We compare the file's
      // current mtime against the snapshot we recorded at read time.
      // The session-read tracker stores mtime in `timestamp`; if that
      // timestamp is older than the current mtime, an external mutation
      // happened and the model's `old_string` may be stale.
      if (sessionId !== undefined) {
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
          const recordedContent = comparableSessionContent(recordedSnapshot);
          const isFullContentMatch =
            recordedSnapshot?.viewKind === "full" &&
            recordedContent === snapshot.content;
          if (!isFullContentMatch) {
            return errorResult(FILE_UNEXPECTEDLY_MODIFIED_ERROR);
          }
        }
      }

      // File exists + empty old_string. Existing empty files still require the
      // full-read and stale-read gates above; only nonexistent creates are
      // exempt.
      if (old_string === "") {
        if (snapshot.content.trim() !== "") {
          return errorResult("Cannot create new file - file already exists.");
        }
        try {
          await writeFilePreservingSnapshot(
            absoluteFilePath,
            new_string,
            snapshot,
          );
        } catch (err) {
          return errorResult(formatWriteFileError(err));
        }
        await snapshotPostWrite(sessionId, absoluteFilePath, new_string);
        notifyLspFileChanged(absoluteFilePath, new_string);
        return {
          content: successText(file_path, false),
          metadata: buildFileMutationMetadata({
            filePath: file_path,
            operation: "edit",
            beforeText: snapshot.content,
            afterText: new_string,
            replacements: 1,
          }),
        };
      }

      const applied = applyValidatedEdit(
        snapshot.content,
        old_string,
        new_string,
        replace_all,
      );
      if ("error" in applied) return errorResult(applied.error);
      const { updated, replacements: matches } = applied;

      try {
        await writeFilePreservingSnapshot(absoluteFilePath, updated, snapshot);
      } catch (err) {
        return errorResult(formatWriteFileError(err));
      }

      await snapshotPostWrite(sessionId, absoluteFilePath, updated);

      notifyLspFileChanged(absoluteFilePath, updated);

      return {
        content: successText(file_path, replace_all),
        metadata: buildFileMutationMetadata({
          filePath: file_path,
          operation: "edit",
          beforeText: snapshot.content,
          afterText: updated,
          replacements: matches,
        }),
      };
    },
  };
}

export function createFileMultiEditTool(config: FileEditToolConfig): Tool {
  return {
    name: FILE_MULTI_EDIT_TOOL_NAME,
    description: FILE_MULTI_EDIT_DESCRIPTION,
    metadata: {
      family: "filesystem",
      source: "builtin",
      keywords: ["multi-edit", "batch", "edit", "replace", "string", "patch"],
      preferredProfiles: ["coding"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
    },
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Workspace-relative path, or a real absolute filesystem path. Do not use /root; that is the agent namespace.",
        },
        edits: {
          type: "array",
          minItems: 1,
          description:
            "Ordered list of exact string replacements to apply to the file.",
          items: {
            type: "object",
            properties: {
              old_string: {
                type: "string",
                description:
                  "The exact text to replace. Must match a unique substring of the current in-memory file unless replace_all is true.",
              },
              new_string: {
                type: "string",
                description: "The replacement text.",
              },
              replace_all: {
                type: "boolean",
                description:
                  "Optional. When true, replace every occurrence of old_string for this edit. Defaults to false.",
              },
            },
            required: ["old_string", "new_string"],
            additionalProperties: false,
          },
        },
      },
      required: ["file_path", "edits"],
      additionalProperties: false,
    },
    checkPermissions(input, context) {
      const args = input as MultiEditArgs;
      const filePath = asNonEmptyString(args.file_path);
      if (!filePath) {
        return {
          behavior: "ask",
          message: "file_path must be a non-empty string",
        };
      }
      const cwd =
        asNonEmptyString(args.cwd) ?? config.allowedPaths[0] ?? process.cwd();
      const firstEdit = Array.isArray(args.edits) ? args.edits[0] : undefined;
      if (isAgentNamespacePath(filePath)) {
        return denyAgentNamespacePath(filePath, cwd);
      }
      const firstOldString =
        firstEdit !== null &&
        typeof firstEdit === "object" &&
        !Array.isArray(firstEdit)
          ? asString((firstEdit as Record<string, unknown>).old_string)
          : undefined;
      return checkToolPathPermission({
        toolName: FILE_MULTI_EDIT_TOOL_NAME,
        input: input as Record<string, unknown>,
        path: filePath,
        cwd,
        context: context.getAppState().toolPermissionContext,
        operationType: firstOldString === "" ? "create" : "write",
        extraWorkingDirectories: config.allowedPaths,
      });
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as MultiEditArgs;
      const validated = validateMultiEditInputs(args);
      if ("error" in validated) return errorResult(validated.error);
      const { file_path, edits } = validated;

      const firstEdit = edits[0];
      if (firstEdit === undefined) {
        return errorResult("edits must be a non-empty array");
      }

      for (const [i, edit] of edits.entries()) {
        if (edit.old_string === edit.new_string) {
          return errorResult(
            `No changes to make: edits[${i}].old_string and edits[${i}].new_string are exactly the same.`,
          );
        }
      }

      const cwd =
        asNonEmptyString(rawArgs.cwd) ?? config.allowedPaths[0] ?? process.cwd();
      if (isAgentNamespacePath(file_path)) {
        return errorResult(agentNamespacePathHint(file_path, cwd));
      }
      const candidatePath = isAbsolute(file_path)
        ? file_path
        : resolve(cwd, file_path);
      const safe = await safePathAllowingSessionPlanFile(
        candidatePath,
        config.allowedPaths,
        rawArgs,
      );
      if (!safe.safe) {
        return errorResult(`Access denied: ${safe.reason}`);
      }
      const absoluteFilePath = safe.resolved;

      if (absoluteFilePath.endsWith(".ipynb")) {
        return errorResult(
          "File is a Jupyter Notebook. Use a notebook-specific tool to edit Jupyter notebooks.",
        );
      }

      let snapshot: FileSnapshot;
      try {
        snapshot = await readFileSnapshot(absoluteFilePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to read file: ${message}`);
      }

      if (snapshot.exists && snapshot.size > MAX_EDIT_FILE_SIZE) {
        return errorResult(
          `File is too large to edit (${snapshot.size} bytes). Maximum editable file size is ${MAX_EDIT_FILE_SIZE} bytes.`,
        );
      }

      if (!snapshot.exists && edits.length === 1 && firstEdit.old_string === "") {
        try {
          await writeFileCreatingParents(absoluteFilePath, firstEdit.new_string);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(`Failed to create file: ${message}`);
        }
        await snapshotPostWrite(
          resolveSessionId(rawArgs),
          absoluteFilePath,
          firstEdit.new_string,
        );
        notifyLspFileChanged(absoluteFilePath, firstEdit.new_string);
        return {
          content: `Created file ${file_path}.`,
          metadata: buildFileMutationMetadata({
            filePath: file_path,
            operation: "create",
            beforeText: "",
            afterText: firstEdit.new_string,
          }),
        };
      }

      if (!snapshot.exists) {
        return errorResult(
          `File does not exist: ${file_path}. To create a new file, pass a single edit with an empty old_string.`,
        );
      }

      const emptyOldStringIndex = edits.findIndex((edit) => edit.old_string === "");
      if (emptyOldStringIndex >= 0) {
        if (edits.length > 1) {
          return errorResult(
            `edits[${emptyOldStringIndex}].old_string cannot be empty in a multi-edit batch.`,
          );
        }
      }

      // Read-before-write enforcement (mirrors the Edit tool path).
      // Production callers MUST inject a session id via SESSION_ID_ARG;
      // tests opt out via __testBypassSessionGuard:true. Failing loud
      // here surfaces any production code path that lost the session
      // id; the previous silent skip hid that class of bug.
      const sessionId = resolveSessionId(rawArgs);
      const bypassSessionGuard = shouldBypassSessionGuard(rawArgs);
      let recordedSnapshot: ReturnType<typeof getSessionReadSnapshot> =
        undefined;
      if (sessionId !== undefined) {
        recordedSnapshot = getSessionReadSnapshot(sessionId, absoluteFilePath);
        if (!isAuthorizingSessionRead(recordedSnapshot)) {
          return errorResult(READ_BEFORE_WRITE_ERROR);
        }
      } else if (!bypassSessionGuard) {
        return errorResult(SESSION_ID_MISSING_ERROR);
      }

      if (sessionId !== undefined) {
        const recordedTs = recordedSnapshot?.timestamp;
        if (
          typeof recordedTs === "number" &&
          Number.isFinite(recordedTs) &&
          snapshot.mtimeMs > recordedTs
        ) {
          const recordedContent = comparableSessionContent(recordedSnapshot);
          const isFullContentMatch =
            recordedSnapshot?.viewKind === "full" &&
            recordedContent === snapshot.content;
          if (!isFullContentMatch) {
            return errorResult(FILE_UNEXPECTEDLY_MODIFIED_ERROR);
          }
        }
      }

      if (emptyOldStringIndex >= 0) {
        if (snapshot.content.trim() !== "") {
          return errorResult("Cannot create new file - file already exists.");
        }
        try {
          await writeFilePreservingSnapshot(
            absoluteFilePath,
            firstEdit.new_string,
            snapshot,
          );
        } catch (err) {
          return errorResult(formatWriteFileError(err));
        }
        await snapshotPostWrite(sessionId, absoluteFilePath, firstEdit.new_string);
        notifyLspFileChanged(absoluteFilePath, firstEdit.new_string);
        return {
          content: multiEditSuccessText(file_path, 1, 1),
          metadata: buildFileMutationMetadata({
            filePath: file_path,
            operation: "edit",
            beforeText: snapshot.content,
            afterText: firstEdit.new_string,
            replacements: 1,
          }),
        };
      }

      let updated = snapshot.content;
      let replacements = 0;
      for (const [i, edit] of edits.entries()) {
        const applied = applyValidatedEdit(
          updated,
          edit.old_string,
          edit.new_string,
          edit.replace_all,
        );
        if ("error" in applied) {
          // MultiEdit is all-or-nothing — when one edit fails the
          // file is left untouched. Tell the model exactly which
          // edits would have applied AND that nothing was written.
          // The previous message ("Edit N failed: <reason>") didn't
          // surface the all-or-nothing semantic, so weak local
          // models (qwen, llama) loop: they re-emit the same broken
          // edit while assuming earlier edits already landed.
          const total = edits.length;
          const failedIndex = i + 1;
          const validatedBefore = i; // edits 1..i were applied to the in-memory buffer
          const parts: string[] = [
            `Edit ${failedIndex} of ${total} failed: ${applied.error}.`,
          ];
          if (validatedBefore > 0) {
            parts.push(
              `Edits 1..${validatedBefore} validated before edit ${failedIndex} failed.`,
            );
          }
          parts.push(
            "MultiEdit is all-or-nothing: the file was NOT written. Re-emit the full edit list with edit",
            String(failedIndex),
            "corrected.",
          );
          return errorResult(parts.join(" "));
        }
        updated = applied.updated;
        replacements += applied.replacements;
      }

      try {
        await writeFilePreservingSnapshot(absoluteFilePath, updated, snapshot);
      } catch (err) {
        return errorResult(formatWriteFileError(err));
      }

      await snapshotPostWrite(sessionId, absoluteFilePath, updated);
      notifyLspFileChanged(absoluteFilePath, updated);

      return {
        content: multiEditSuccessText(file_path, edits.length, replacements),
        metadata: buildFileMutationMetadata({
          filePath: file_path,
          operation: "edit",
          beforeText: snapshot.content,
          afterText: updated,
          replacements,
        }),
      };
    },
  };
}
