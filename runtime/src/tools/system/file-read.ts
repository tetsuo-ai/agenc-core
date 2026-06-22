/**
 * `FileRead` — first-class file reading tool for AgenC.
 *
 * Lifted (and adapted) from the upstream file-read tool. The
 * model-facing prompt mirrors AgenC's `FileReadTool/prompt.ts` so
 * a model trained on the AgenC surface behaves identically here.
 *
 * Key behaviors preserved from AgenC:
 *   - Token-aware text-file size cap (defaults to 25k tokens, matching
 *     the upstream `DEFAULT_MAX_OUTPUT_TOKENS`). When the rough estimate
 *     exceeds the cap, the read is rejected with the exact error
 *     message AgenC emits so model-side recovery copy still works.
 *   - Image multimodal output: PNG/JPG/JPEG/GIF/WEBP read as bytes,
 *     base64-encoded, and returned via `contentItems` as
 *     `input_image` with a data URL. The text `content` carries a
 *     short summary so the runtime envelope is never empty.
 *   - PDF text extraction uses the upstream-style Poppler path
 *     (`pdfinfo` + `pdftotext`) with page-range guards and a large-PDF
 *     prompt that asks the model to request explicit pages.
 *   - Binary files that aren't images or PDFs return an actionable
 *     error directing the model to use a different tool, instead of
 *     leaking unprintable bytes into the conversation.
 *   - Notebook files (`.ipynb`) are parsed into a stable, line-numbered
 *     view of cells, source, text outputs, errors, and embedded images.
 *   - `offset` / `limit` produce a partial line view. Partial reads
 *     are recorded with `viewKind: "partial"` in the session-read
 *     tracker for range-aware dedup, but — like full reads — they
 *     satisfy `Edit`/`Write`'s read-before-write gate: any real read of
 *     the path authorizes a subsequent edit. Only synthetic processed
 *     partial views (`isPartialView: true`) fail the gate.
 *   - Successful reads that DO yield content are recorded with the
 *     content snapshot so AgenC's compaction-aware re-injection helpers
 *     (`snapshotTopRecentReads`) can rebuild context after a compact.
 *
 * The error envelope is plain text in `content` with `isError: true` —
 * runtime shape, not JSON-wrapped. Matches the envelope used by `Edit`
 * and `Write`.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

import type {
  Tool,
  ToolExecutionInjectedArgs,
  ToolResult,
} from "../types.js";
import type { FunctionCallOutputContentItem } from "../context.js";
import { addLineNumbers } from "./_deps/line-numbers.js";
import {
  recordSessionRead,
  resolveSessionId,
  safePathAllowingSessionPlanFile,
  withSignedAllowedRoots,
} from "./filesystem.js";
import {
  agentNamespacePathHint,
  denyAgentNamespacePath,
  isAgentNamespacePath,
} from "./agent-path-hints.js";
import { checkToolPathPermission } from "../../permissions/path-validation.js";
import { roughTokenCountEstimationForFileType } from "../../llm/token-estimation.js";
import {
  parsePDFPageRange as parseSharedPDFPageRange,
  type PDFPageRange,
} from "../../utils/pdfPageRange.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** Public tool name — registered by the parent into the tool registry. */
export const FILE_READ_TOOL_NAME = "FileRead";

/**
 * Token cap for text reads. Matches AgenC's
 * `DEFAULT_MAX_OUTPUT_TOKENS` from `FileReadTool/limits.ts`. Configurable
 * via the `AGENC_FILE_READ_MAX_OUTPUT_TOKENS` env var (kept for
 * parity with AgenC's user-side override) or via `FileReadConfig`.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 25_000;

/**
 * Default upper bound on raw file size for text reads. 256 KB is the
 * upstream `MAX_OUTPUT_SIZE` derived value. Acts as a cheap pre-read
 * gate so we don't slurp gigantic files into memory just to reject them
 * post-read on the token cap.
 */
const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;

/** Default output cap for image reads in bytes. */
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Default output cap for PDF files in bytes. */
const DEFAULT_MAX_PDF_BYTES = 32 * 1024 * 1024;

/** Default raw JSON cap for notebook reads before parsing. */
const DEFAULT_MAX_NOTEBOOK_BYTES = 16 * 1024 * 1024;

/** Upstream PDF safety limits. */
const PDF_LARGE_PAGE_THRESHOLD = 10;
const PDF_MAX_PAGES_PER_REQUEST = 20;
const PDF_SUBPROCESS_TIMEOUT_MS = 120_000;
const NOTEBOOK_LARGE_OUTPUT_THRESHOLD = 10_000;

/** Default upper line count when no explicit `limit` is supplied. */
const DEFAULT_LINE_LIMIT = 2000;

/** Image extensions the tool will accept and emit as multimodal output. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Mime types keyed by canonical extension. */
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Binary-file extension list (lifted from AgenC
 * `src/constants/files.ts`). Used to short-circuit reads of non-text,
 * non-image, non-PDF files with a useful error message.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".tif",
  // Videos
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".m4v",
  ".mpeg", ".mpg",
  // Audio
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma", ".aiff", ".opus",
  // Archives
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz", ".z", ".tgz", ".iso",
  // Executables / object code
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".obj", ".lib",
  ".app", ".msi", ".deb", ".rpm",
  // Documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".odt", ".ods", ".odp",
  // Fonts
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  // Bytecode
  ".pyc", ".pyo", ".class", ".jar", ".war", ".ear", ".node", ".wasm", ".rlib",
  // Database
  ".sqlite", ".sqlite3", ".db", ".mdb", ".idx",
  // Design / 3D
  ".psd", ".ai", ".eps", ".sketch", ".fig", ".xd", ".blend", ".3ds", ".max",
  // Flash
  ".swf", ".fla",
  // Lock / profiling
  ".lockb", ".dat", ".data",
]);

const PDF_EXTENSION = ".pdf";
const NOTEBOOK_EXTENSION = ".ipynb";

export interface FileReadEvent {
  readonly filePath: string;
  readonly content: string;
  readonly sessionId?: string;
}

export type FileReadListener = (event: FileReadEvent) => void;

const fileReadListeners = new Set<FileReadListener>();

export function registerFileReadListener(
  listener: FileReadListener,
): () => void {
  fileReadListeners.add(listener);
  return () => {
    fileReadListeners.delete(listener);
  };
}

export function clearFileReadListenersForTests(): void {
  fileReadListeners.clear();
}

// ─────────────────────────────────────────────────────────────────────
// Description (model-facing)
// ─────────────────────────────────────────────────────────────────────

/**
 * AgenC file-read prompt template.
 * Image / PDF / notebook mentions are kept so the model knows the
 * tool's capability surface.
 */
const FILE_READ_DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- Use workspace-relative paths like 'game.py' unless the user provided a real absolute path. Do not use '/root/...'; '/root' is the agent namespace, not the filesystem.
- By default, it reads up to ${DEFAULT_LINE_LIMIT} lines starting from the beginning of the file
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows AgenC to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually because AgenC can inspect multimodal inputs.
- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.
- This tool can read Jupyter notebook files (.ipynb) and returns cells with their source, text outputs, errors, and embedded visual outputs.
- This tool can only read files, not directories. To list files in a directory, use the registered shell tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.`;

// ─────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────

/** Tool factory configuration. */
export interface FileReadToolConfig {
  /**
   * Allowed path prefixes (required — no default). Same shape as the
   * filesystem-tool config so the parent can pass through the workspace
   * root list verbatim.
   */
  readonly allowedPaths: readonly string[];
  /** Token cap for text reads (default: 25k). */
  readonly maxTokens?: number;
  /** Raw byte cap for text reads (default: 256 KB). */
  readonly maxTextBytes?: number;
  /** Raw byte cap for image reads (default: 10 MB). */
  readonly maxImageBytes?: number;
  /** Raw byte cap for PDF reads (default: 32 MB). */
  readonly maxPdfBytes?: number;
  /** Raw byte cap for notebook reads before parsing (default: 16 MB). */
  readonly maxNotebookBytes?: number;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Runtime-shape error envelope: plain text body, isError flag. */
function errorResult(message: string): ToolResult {
  return { content: message, isError: true };
}

/** Coerce optional positive integers (model may emit ints as strings). */
function parsePositiveIntArg(
  value: unknown,
  name: string,
): { value: number | undefined } | { err: ToolResult } {
  if (value === undefined) return { value: undefined };
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1
  ) {
    return { value };
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    return { value: Number.parseInt(value.trim(), 10) };
  }
  return { err: errorResult(`${name} must be a positive integer`) };
}

/** 5-line file-size formatter. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Cheap token estimate. Matches the spirit of AgenC's
 * `roughTokenCountEstimationForFileType` — for source code 1 token ~= 4
 * characters is a deliberate underestimate. We use it as a fast gate
 * before paying for an actual tokenizer call (which AgenC does not have
 * here). Aligns with how AgenC's `validateContentTokens` uses the
 * rough estimate to decide whether to invoke the API tokenizer.
 */
function estimateTokens(content: string, fileExtension = ""): number {
  return roughTokenCountEstimationForFileType(content, fileExtension);
}

/**
 * Detect whether a buffer looks binary (null bytes or >10% non-printable
 * in the first 8 KB). Same heuristic AgenC uses in
 * `constants/files.ts:isBinaryContent`.
 */
function isBinaryContent(buffer: Buffer): boolean {
  const checkSize = Math.min(buffer.length, 8192);
  let nonPrintable = 0;
  for (let i = 0; i < checkSize; i += 1) {
    const byte = buffer[i] ?? 0;
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintable += 1;
    }
  }
  if (checkSize === 0) return false;
  return nonPrintable / checkSize > 0.1;
}

/** Check whether the file extension is in the binary block-list. */
function hasBinaryExtension(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex < 0) return false;
  const ext = filePath.slice(dotIndex).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** Produce the runtime `cat -n` style numbered output. */
function formatNumbered(content: string, startLine: number): string {
  return addLineNumbers({ content, startLine });
}

function notifyFileReadListeners(event: FileReadEvent): void {
  for (const listener of [...fileReadListeners]) {
    try {
      listener(event);
    } catch {
      // FileRead success must not depend on best-effort post-read hooks.
    }
  }
}

interface SliceResult {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly numLines: number;
  readonly isPartial: boolean;
}

function sliceLines(text: string, offset: number, limit: number | undefined): SliceResult {
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = Math.max(1, offset);
  const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;
  const endLine = Math.min(totalLines, startLine + effectiveLimit - 1);
  const selected =
    totalLines === 0 || startLine > totalLines
      ? []
      : lines.slice(startLine - 1, endLine);
  const explicitWindow = offset > 1 || limit !== undefined;
  const isPartial =
    explicitWindow ||
    !(startLine === 1 && selected.length === totalLines);
  return {
    content: selected.join("\n"),
    startLine,
    endLine: Math.max(startLine, endLine),
    totalLines,
    numLines: selected.length,
    isPartial,
  };
}

async function readInitialBytes(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function sliceTextFileByLineStream(
  filePath: string,
  offset: number,
  limit: number | undefined,
): Promise<SliceResult> {
  const startLine = Math.max(1, offset);
  const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;
  const selected: string[] = [];
  let totalLines = 0;

  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      totalLines += 1;
      if (
        totalLines >= startLine &&
        selected.length < effectiveLimit
      ) {
        selected.push(line);
      }
      if (selected.length >= effectiveLimit) {
        break;
      }
    }
  } finally {
    reader.close();
    input.destroy();
  }

  const endLine =
    selected.length > 0
      ? startLine + selected.length - 1
      : Math.max(startLine, Math.min(totalLines, startLine + effectiveLimit - 1));
  return {
    content: selected.join("\n"),
    startLine,
    endLine,
    totalLines,
    numLines: selected.length,
    isPartial: true,
  };
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function execFileNoThrow(
  command: string,
  args: readonly string[],
  timeoutMs = PDF_SUBPROCESS_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({
          exitCode,
          stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
          stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
        });
      },
    );
  });
}

function parsePDFPageRangeArg(
  pages: unknown,
): PDFPageRange | { err: string } | null {
  if (pages === undefined || pages === null) return null;
  if (typeof pages !== "string" || pages.trim().length === 0) {
    return { err: "pages must be a non-empty string when provided" };
  }

  const trimmed = pages.trim();
  return parseSharedPDFPageRange(trimmed) ?? {
    err: `Invalid PDF page range: ${trimmed}`,
  };
}

function pageRangeLength(range: PDFPageRange): number {
  if (range.lastPage === Infinity) return Infinity;
  return range.lastPage - range.firstPage + 1;
}

async function getPDFPageCount(filePath: string): Promise<number | null> {
  const result = await execFileNoThrow("pdfinfo", [filePath], 10_000);
  if (result.exitCode !== 0) return null;
  const match = /^Pages:\s+(\d+)/mu.exec(result.stdout);
  if (!match) return null;
  const count = Number.parseInt(match[1]!, 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}
// ─────────────────────────────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────────────────────────────

interface ResolvedPath {
  readonly absolute: string;
  readonly canonical: string;
}

async function resolveAndCheck(
  rawPath: string,
  config: FileReadToolConfig,
  args: Record<string, unknown>,
): Promise<{ ok: ResolvedPath } | { err: ToolResult }> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { err: errorResult("file_path must be a non-empty string") };
  }
  // Resolve relative paths against either an explicit `cwd` arg, the
  // first allowed path, or process.cwd() as a last resort.
  const cwdArg =
    typeof args.cwd === "string" && args.cwd.trim().length > 0
      ? args.cwd
      : config.allowedPaths[0] ?? process.cwd();
  if (isAgentNamespacePath(rawPath)) {
    return { err: errorResult(agentNamespacePathHint(rawPath, cwdArg)) };
  }
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwdArg, rawPath);
  const safe = await safePathAllowingSessionPlanFile(
    absolute,
    config.allowedPaths,
    args,
  );
  if (!safe.safe) {
    return { err: errorResult(`Access denied: ${safe.reason}`) };
  }
  return { ok: { absolute, canonical: safe.resolved } };
}

// ─────────────────────────────────────────────────────────────────────
// Read paths
// ─────────────────────────────────────────────────────────────────────

interface TextReadOpts {
  readonly maxTextBytes: number;
  readonly maxTokens: number;
  readonly offset: number;
  readonly limit: number | undefined;
  readonly displayPath: string;
}

async function readTextFile(
  resolvedPath: ResolvedPath,
  opts: TextReadOpts,
  sessionId: string | undefined,
): Promise<ToolResult> {
  const fileStats = await stat(resolvedPath.canonical);
  if (!fileStats.isFile()) {
    return errorResult("Path is not a regular file");
  }
  const explicitWindow = opts.offset > 1 || opts.limit !== undefined;
  if (!explicitWindow && fileStats.size > opts.maxTextBytes) {
    return errorResult(
      `File size ${formatBytes(fileStats.size)} exceeds the text-read limit of ${formatBytes(
        opts.maxTextBytes,
      )}. Use offset and limit to read a slice, or a different tool for large binary blobs.`,
    );
  }
  const shouldStreamWindow = explicitWindow && fileStats.size > opts.maxTextBytes;
  const binarySample = shouldStreamWindow
    ? await readInitialBytes(resolvedPath.canonical, 8192)
    : await readFile(resolvedPath.canonical);
  if (isBinaryContent(binarySample)) {
    return errorResult(
      "This tool cannot read binary files. The file contains non-text bytes. Use a different tool (e.g. a hex viewer or shell tooling) for binary file analysis.",
    );
  }

  const text = shouldStreamWindow
    ? undefined
    : binarySample.toString("utf-8");
  const sliced = shouldStreamWindow
    ? await sliceTextFileByLineStream(resolvedPath.canonical, opts.offset, opts.limit)
    : sliceLines(text ?? "", opts.offset, opts.limit);
  const slicedBytes = Buffer.byteLength(sliced.content, "utf8");
  if (slicedBytes > opts.maxTextBytes) {
    return errorResult(
      `File slice (${formatBytes(slicedBytes)}) exceeds the text-read limit of ${formatBytes(
        opts.maxTextBytes,
      )}. Use a smaller offset and limit window.`,
    );
  }

  // Token cap — match AgenC's MaxFileReadTokenExceededError
  // verbatim so any model-side recovery prompt still triggers.
  const estimated = estimateTokens(sliced.content, extname(opts.displayPath));
  if (estimated > opts.maxTokens) {
    return errorResult(
      `File content (${estimated} tokens) exceeds maximum allowed tokens (${opts.maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    );
  }

  // Record the read in session state. Partial reads carry
  // `viewKind: "partial"` for range-aware dedup and snapshot checks, but
  // still satisfy the read-before-write gate. AgenC only blocks
  // auto-injected processed partial views; AgenC does not populate that
  // path here.
  recordSessionRead(sessionId, resolvedPath.canonical, {
    content: sliced.content,
    timestamp:
      typeof fileStats.mtimeMs === "number" && Number.isFinite(fileStats.mtimeMs)
        ? fileStats.mtimeMs
        : Date.now(),
    viewKind: sliced.isPartial ? "partial" : "full",
    ...(sliced.isPartial ? { readOffset: sliced.startLine } : {}),
    ...(sliced.isPartial && opts.limit !== undefined
      ? { readLimit: opts.limit }
      : {}),
    // Full reads carry the raw disk bytes for the per-turn changed-files
    // attachment producer to compute exact diffs on later mutation.
    // Partial reads intentionally skip rawContent — without the full file
    // there is nothing to diff against.
    ...(sliced.isPartial || text === undefined ? {} : { rawContent: text }),
  });
  notifyFileReadListeners({
    filePath: resolvedPath.canonical,
    content: text ?? sliced.content,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });

  if (sliced.content.length === 0) {
    if (sliced.totalLines === 0) {
      return {
        content:
          "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
        metadata: {
          filePath: opts.displayPath,
          totalLines: 0,
          startLine: sliced.startLine,
          numLines: 0,
          isPartial: sliced.isPartial,
        },
      };
    }
    return {
      content: `<system-reminder>Warning: the file exists but is shorter than the provided offset (${sliced.startLine}). The file has ${sliced.totalLines} lines.</system-reminder>`,
      metadata: {
        filePath: opts.displayPath,
        totalLines: sliced.totalLines,
        startLine: sliced.startLine,
        numLines: 0,
        isPartial: sliced.isPartial,
      },
    };
  }

  return {
    content: formatNumbered(sliced.content, sliced.startLine),
    metadata: {
      filePath: opts.displayPath,
      totalLines: sliced.totalLines,
      startLine: sliced.startLine,
      endLine: sliced.endLine,
      numLines: sliced.numLines,
      isPartial: sliced.isPartial,
    },
  };
}

interface NotebookReadOpts extends TextReadOpts {
  readonly maxImageBytes: number;
  readonly maxNotebookBytes: number;
}

interface NotebookImageOutput {
  readonly lineNumber: number;
  readonly mime: string;
  readonly base64: string;
}

interface NotebookRenderResult {
  readonly text: string;
  readonly images: readonly NotebookImageOutput[];
  readonly cellCount: number;
  readonly language: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function joinNotebookText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : String(part ?? "")))
      .join("");
  }
  return "";
}

function truncateNotebookOutput(text: string): string {
  if (text.length <= NOTEBOOK_LARGE_OUTPUT_THRESHOLD) return text;
  return `${text.slice(0, NOTEBOOK_LARGE_OUTPUT_THRESHOLD)}\n[output truncated]`;
}

function extractNotebookTextOutput(output: Record<string, unknown>): string {
  const outputType = output.output_type;
  if (outputType === "stream") {
    return truncateNotebookOutput(joinNotebookText(output.text));
  }
  if (outputType === "execute_result" || outputType === "display_data") {
    const data = asRecord(output.data);
    if (!data) return "";
    return truncateNotebookOutput(joinNotebookText(data["text/plain"]));
  }
  if (outputType === "error") {
    const ename = typeof output.ename === "string" ? output.ename : "Error";
    const evalue = typeof output.evalue === "string" ? output.evalue : "";
    const traceback = joinNotebookText(output.traceback);
    return truncateNotebookOutput(
      [evalue.length > 0 ? `${ename}: ${evalue}` : ename, traceback]
        .filter((part) => part.length > 0)
        .join("\n"),
    );
  }
  return "";
}

function extractNotebookImageOutput(
  output: Record<string, unknown>,
): { readonly mime: string; readonly base64: string } | null {
  const data = asRecord(output.data);
  if (!data) return null;
  const png = joinNotebookText(data["image/png"]);
  if (png.length > 0) {
    return { mime: "image/png", base64: png.replace(/\s/g, "") };
  }
  const jpeg = joinNotebookText(data["image/jpeg"]);
  if (jpeg.length > 0) {
    return { mime: "image/jpeg", base64: jpeg.replace(/\s/g, "") };
  }
  return null;
}

function pushNotebookMultiline(lines: string[], text: string): void {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const split = normalized.length === 0 ? [""] : normalized.split("\n");
  for (const line of split) lines.push(line);
}

function renderNotebook(
  rawText: string,
  displayPath: string,
  maxImageBytes: number,
): { ok: NotebookRenderResult } | { err: ToolResult } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { err: errorResult(`Invalid notebook JSON: ${detail}`) };
  }

  const notebook = asRecord(parsed);
  const cells = Array.isArray(notebook?.cells) ? notebook.cells : null;
  if (!notebook || !cells) {
    return { err: errorResult("Invalid notebook: expected a cells array") };
  }

  const metadata = asRecord(notebook.metadata);
  const languageInfo = asRecord(metadata?.language_info);
  const language =
    typeof languageInfo?.name === "string" && languageInfo.name.length > 0
      ? languageInfo.name
      : "python";
  const lines = [
    `Notebook: ${displayPath}`,
    `Language: ${language}`,
    `Cells: ${cells.length}`,
    "",
  ];
  const images: NotebookImageOutput[] = [];

  if (cells.length === 0) {
    lines.push("No cells.");
  }

  cells.forEach((rawCell, cellIndex) => {
    const cell = asRecord(rawCell) ?? {};
    const cellType =
      typeof cell.cell_type === "string" && cell.cell_type.length > 0
        ? cell.cell_type
        : "unknown";
    const cellId =
      typeof cell.id === "string" && cell.id.length > 0
        ? ` id=${cell.id}`
        : "";
    const executionCount =
      typeof cell.execution_count === "number"
        ? ` execution_count=${cell.execution_count}`
        : "";

    if (cellIndex > 0) lines.push("");
    lines.push(`Cell ${cellIndex + 1} [${cellType}]${cellId}${executionCount}`);
    lines.push("Source:");
    pushNotebookMultiline(lines, joinNotebookText(cell.source));

    if (cellType !== "code") return;
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    if (outputs.length === 0) {
      lines.push("Outputs: none");
      return;
    }

    const processedOutputs = outputs.map((rawOutput) => asRecord(rawOutput) ?? {});
    const totalTextOutputSize = processedOutputs.reduce(
      (total, output) => total + extractNotebookTextOutput(output).length,
      0,
    );
    const omitTextOutputs = totalTextOutputSize > NOTEBOOK_LARGE_OUTPUT_THRESHOLD;
    if (omitTextOutputs) {
      lines.push(
        `Text outputs are too large to include. Use a shell command with jq to inspect cells[${cellIndex}].outputs.`,
      );
    }

    processedOutputs.forEach((output, outputIndex) => {
      const outputType =
        typeof output.output_type === "string" && output.output_type.length > 0
          ? output.output_type
          : "unknown";
      lines.push(`Output ${outputIndex + 1} [${outputType}]:`);
      const text = extractNotebookTextOutput(output);
      if (!omitTextOutputs && text.length > 0) pushNotebookMultiline(lines, text);
      const image = extractNotebookImageOutput(output);
      if (image) {
        const imageBytes = Buffer.byteLength(image.base64, "base64");
        if (imageBytes > maxImageBytes) {
          lines.push(
            `Image output ${outputIndex + 1} [${image.mime}] exceeds the image-read limit of ${formatBytes(maxImageBytes)}.`,
          );
        } else {
          const lineNumber = lines.length + 1;
          lines.push(
            `Image output ${outputIndex + 1} [${image.mime}]: embedded image output`,
          );
          images.push({
            lineNumber,
            mime: image.mime,
            base64: image.base64,
          });
        }
      }
      if ((!omitTextOutputs && text.length === 0) && !image) {
        lines.push("(empty output)");
      }
    });
  });

  return {
    ok: {
      text: lines.join("\n"),
      images,
      cellCount: cells.length,
      language,
    },
  };
}

async function readNotebookFile(
  resolvedPath: ResolvedPath,
  opts: NotebookReadOpts,
  sessionId: string | undefined,
): Promise<ToolResult> {
  const fileStats = await stat(resolvedPath.canonical);
  if (!fileStats.isFile()) {
    return errorResult("Path is not a regular file");
  }
  if (fileStats.size > opts.maxNotebookBytes) {
    return errorResult(
      `Notebook size ${formatBytes(fileStats.size)} exceeds the notebook-read limit of ${formatBytes(
        opts.maxNotebookBytes,
      )}. Use a shell command with jq to inspect specific cells without loading the whole notebook.`,
    );
  }

  const rawText = await readFile(resolvedPath.canonical, "utf8");
  const rendered = renderNotebook(rawText, opts.displayPath, opts.maxImageBytes);
  if ("err" in rendered) return rendered.err;

  const sliced = sliceLines(rendered.ok.text, opts.offset, opts.limit);
  const slicedBytes = Buffer.byteLength(sliced.content, "utf8");
  if (slicedBytes > opts.maxTextBytes) {
    return errorResult(
      `Notebook content (${formatBytes(slicedBytes)}) exceeds the text-read limit of ${formatBytes(
        opts.maxTextBytes,
      )}. Use offset and limit to read a smaller slice.`,
    );
  }

  const estimated = estimateTokens(sliced.content, NOTEBOOK_EXTENSION);
  if (estimated > opts.maxTokens) {
    return errorResult(
      `Notebook content (${estimated} tokens) exceeds maximum allowed tokens (${opts.maxTokens}). Use offset and limit parameters to read specific portions of the notebook.`,
    );
  }

  recordSessionRead(sessionId, resolvedPath.canonical, {
    content: sliced.content,
    timestamp:
      typeof fileStats.mtimeMs === "number" && Number.isFinite(fileStats.mtimeMs)
        ? fileStats.mtimeMs
        : Date.now(),
    viewKind: sliced.isPartial ? "partial" : "full",
    ...(sliced.isPartial ? { readOffset: sliced.startLine } : {}),
    ...(sliced.isPartial && opts.limit !== undefined
      ? { readLimit: opts.limit }
      : {}),
    ...(sliced.isPartial ? {} : { rawContent: rawText }),
  });

  if (sliced.content.length === 0) {
    return {
      content: `<system-reminder>Warning: the notebook exists but is shorter than the provided offset (${sliced.startLine}). The rendered notebook has ${sliced.totalLines} lines.</system-reminder>`,
      metadata: {
        filePath: opts.displayPath,
        mediaType: "application/x-ipynb+json",
        totalLines: sliced.totalLines,
        startLine: sliced.startLine,
        numLines: 0,
        isPartial: sliced.isPartial,
        cellCount: rendered.ok.cellCount,
        language: rendered.ok.language,
      },
    };
  }

  const numbered = formatNumbered(sliced.content, sliced.startLine);
  const selectedImages = rendered.ok.images.filter(
    (image) =>
      image.lineNumber >= sliced.startLine && image.lineNumber <= sliced.endLine,
  );
  const contentItems: FunctionCallOutputContentItem[] = selectedImages.length
    ? [
        { type: "input_text", text: numbered },
        ...selectedImages.map((image) => ({
          type: "input_image" as const,
          image_url: `data:${image.mime};base64,${image.base64}`,
        })),
      ]
    : [];

  return {
    content: numbered,
    ...(contentItems.length > 0 ? { contentItems } : {}),
    metadata: {
      filePath: opts.displayPath,
      mediaType: "application/x-ipynb+json",
      totalLines: sliced.totalLines,
      startLine: sliced.startLine,
      endLine: sliced.endLine,
      numLines: sliced.numLines,
      isPartial: sliced.isPartial,
      cellCount: rendered.ok.cellCount,
      language: rendered.ok.language,
    },
  };
}

interface ImageReadOpts {
  readonly displayPath: string;
  readonly ext: string;
  readonly maxImageBytes: number;
}

interface PDFReadOpts {
  readonly displayPath: string;
  readonly maxPdfBytes: number;
  readonly pages: unknown;
  readonly maxTokens: number;
  readonly offset: number;
  readonly limit: number | undefined;
}

async function readPDFFile(
  resolvedPath: ResolvedPath,
  opts: PDFReadOpts,
  sessionId: string | undefined,
): Promise<ToolResult> {
  const fileStats = await stat(resolvedPath.canonical);
  if (!fileStats.isFile()) {
    return errorResult("Path is not a regular file");
  }
  if (fileStats.size === 0) {
    return errorResult(`PDF file is empty: ${opts.displayPath}`);
  }
  if (fileStats.size > opts.maxPdfBytes) {
    return errorResult(
      `PDF size ${formatBytes(fileStats.size)} exceeds the PDF-read limit of ${formatBytes(
        opts.maxPdfBytes,
      )}. Provide a smaller PDF or extract the relevant pages first.`,
    );
  }

  const header = (await readFile(resolvedPath.canonical))
    .subarray(0, 5)
    .toString("ascii");
  if (!header.startsWith("%PDF-")) {
    return errorResult(
      `File is not a valid PDF (missing %PDF- header): ${opts.displayPath}`,
    );
  }

  const parsedRange = parsePDFPageRangeArg(opts.pages);
  if (parsedRange && "err" in parsedRange) {
    return errorResult(parsedRange.err);
  }

  const pageCount = await getPDFPageCount(resolvedPath.canonical);
  const selectedRange =
    parsedRange ??
    (pageCount === null
      ? null
      : { firstPage: 1, lastPage: pageCount });

  if (
    pageCount !== null &&
    parsedRange === null &&
    pageCount > PDF_LARGE_PAGE_THRESHOLD
  ) {
    return errorResult(
      `PDF has ${pageCount} pages. Provide the pages parameter for PDFs over ${PDF_LARGE_PAGE_THRESHOLD} pages (maximum ${PDF_MAX_PAGES_PER_REQUEST} pages per request).`,
    );
  }
  if (
    selectedRange !== null &&
    pageRangeLength(selectedRange) > PDF_MAX_PAGES_PER_REQUEST
  ) {
    return errorResult(
      `PDF page range is too large. Maximum ${PDF_MAX_PAGES_PER_REQUEST} pages per request.`,
    );
  }

  const args = ["-layout", "-nopgbrk", "-q"];
  if (selectedRange !== null) {
    args.push("-f", String(selectedRange.firstPage));
    if (selectedRange.lastPage !== Infinity) {
      args.push("-l", String(selectedRange.lastPage));
    }
  }
  args.push(resolvedPath.canonical, "-");

  const extracted = await execFileNoThrow("pdftotext", args);
  if (extracted.exitCode !== 0) {
    const detail = extracted.stderr.trim();
    return errorResult(
      detail.length > 0
        ? `PDF text extraction failed: ${detail}`
        : "PDF text extraction failed. Install poppler-utils (`pdftotext`) to enable PDF reading.",
    );
  }

  const text = extracted.stdout.trimEnd();
  const sliced = sliceLines(text, opts.offset, opts.limit);
  const estimated = estimateTokens(sliced.content);
  if (estimated > opts.maxTokens) {
    return errorResult(
      `PDF content (${estimated} tokens) exceeds maximum allowed tokens (${opts.maxTokens}). Provide a narrower pages range or offset/limit window.`,
    );
  }

  const isPartial = parsedRange !== null || sliced.isPartial;

  recordSessionRead(sessionId, resolvedPath.canonical, {
    content: sliced.content,
    timestamp:
      typeof fileStats.mtimeMs === "number" && Number.isFinite(fileStats.mtimeMs)
        ? fileStats.mtimeMs
        : Date.now(),
    viewKind: isPartial ? "partial" : "full",
    ...(sliced.isPartial
      ? { readOffset: sliced.startLine }
      : parsedRange
        ? { readOffset: selectedRange?.firstPage ?? 1 }
        : {}),
    ...(sliced.isPartial && opts.limit !== undefined
      ? { readLimit: opts.limit }
      : parsedRange && selectedRange && selectedRange.lastPage !== Infinity
      ? { readLimit: pageRangeLength(selectedRange) }
      : {}),
    ...(isPartial ? {} : { rawContent: text }),
  });

  if (text.length === 0) {
    return {
      content:
        "<system-reminder>Warning: the PDF exists but no extractable text was found.</system-reminder>",
      metadata: {
        filePath: opts.displayPath,
        mediaType: "application/pdf",
        totalPages: pageCount,
        totalLines: 0,
        startLine: sliced.startLine,
        numLines: 0,
        isPartial,
      },
    };
  }
  if (sliced.content.length === 0) {
    return {
      content: `<system-reminder>Warning: the PDF exists but is shorter than the provided offset (${sliced.startLine}). The extracted PDF text has ${sliced.totalLines} lines.</system-reminder>`,
      metadata: {
        filePath: opts.displayPath,
        mediaType: "application/pdf",
        totalPages: pageCount,
        totalLines: sliced.totalLines,
        startLine: sliced.startLine,
        numLines: 0,
        isPartial,
      },
    };
  }

  const rangeLabel =
    selectedRange === null
      ? pageCount === null
        ? "all detected text"
        : `pages 1-${pageCount}`
      : selectedRange.lastPage === Infinity
        ? `pages ${selectedRange.firstPage}-end`
        : `pages ${selectedRange.firstPage}-${selectedRange.lastPage}`;

  return {
    content: `Read PDF ${opts.displayPath} (${rangeLabel})\n\n${formatNumbered(
      sliced.content,
      sliced.startLine,
    )}`,
    metadata: {
      filePath: opts.displayPath,
      mediaType: "application/pdf",
      sizeBytes: fileStats.size,
      totalPages: pageCount,
      totalLines: sliced.totalLines,
      startLine: sliced.startLine,
      endLine: sliced.endLine,
      numLines: sliced.numLines,
      pageRange: rangeLabel,
      isPartial,
    },
  };
}

async function readImageFile(
  resolvedPath: ResolvedPath,
  opts: ImageReadOpts,
  sessionId: string | undefined,
): Promise<ToolResult> {
  const fileStats = await stat(resolvedPath.canonical);
  if (!fileStats.isFile()) {
    return errorResult("Path is not a regular file");
  }
  if (fileStats.size > opts.maxImageBytes) {
    return errorResult(
      `Image size ${formatBytes(fileStats.size)} exceeds the image-read limit of ${formatBytes(
        opts.maxImageBytes,
      )}.`,
    );
  }
  if (fileStats.size === 0) {
    return errorResult(`Image file is empty: ${opts.displayPath}`);
  }

  const buffer = await readFile(resolvedPath.canonical);
  const mime = IMAGE_MIME_BY_EXT[opts.ext] ?? "application/octet-stream";
  const base64 = buffer.toString("base64");

  // Record the read with no text content (binary). Use `viewKind: "full"`
  // — there is no "partial image" concept and we want subsequent reads
  // of the same image to dedup if the session needs the gate. The
  // changed-files producer uses `rawContent` (base64 here) as the diff
  // anchor for image edits.
  recordSessionRead(sessionId, resolvedPath.canonical, {
    content: null,
    timestamp:
      typeof fileStats.mtimeMs === "number" && Number.isFinite(fileStats.mtimeMs)
        ? fileStats.mtimeMs
        : Date.now(),
    viewKind: "full",
    rawContent: base64,
  });

  // The `FunctionCallOutputContentItem` shape (port of the runtime
  // `FunctionCallOutputContentItem`) accepts `input_image` carrying a
  // branding-scan: allow real provider API name in data URL compatibility note
  // URL — providers that support the OpenAI Responses API consume data
  // URLs verbatim. The text body remains a brief summary so the runtime
  // envelope is never empty.
  const dataUrl = `data:${mime};base64,${base64}`;
  const contentItems: FunctionCallOutputContentItem[] = [
    {
      type: "input_text",
      text: `Read image ${opts.displayPath} (${formatBytes(fileStats.size)}, ${mime})`,
    },
    { type: "input_image", image_url: dataUrl },
  ];

  return {
    content: `Read image ${opts.displayPath} (${formatBytes(fileStats.size)}, ${mime})`,
    contentItems,
    metadata: {
      filePath: opts.displayPath,
      mediaType: mime,
      sizeBytes: fileStats.size,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────────────────────────────

interface FileReadInput extends ToolExecutionInjectedArgs {
  readonly file_path?: unknown;
  readonly offset?: unknown;
  readonly limit?: unknown;
  readonly pages?: unknown;
  readonly cwd?: unknown;
  readonly __agencSessionId?: unknown;
}

export function createFileReadTool(config: FileReadToolConfig): Tool {
  const maxTokens = config.maxTokens ?? envOrDefault(DEFAULT_MAX_OUTPUT_TOKENS);
  const maxTextBytes = config.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  const maxImageBytes = config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxPdfBytes = config.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES;
  const maxNotebookBytes =
    config.maxNotebookBytes ?? DEFAULT_MAX_NOTEBOOK_BYTES;

  return {
    name: FILE_READ_TOOL_NAME,
    description: FILE_READ_DESCRIPTION,
    metadata: {
      family: "filesystem",
      source: "builtin",
      keywords: ["read", "file", "image", "notebook", "view", "cat"],
      preferredProfiles: ["coding", "general", "operator"],
      hiddenByDefault: false,
      mutating: false,
      deferred: false,
    },
    isReadOnly: true,
    recoveryCategory: "idempotent",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Workspace-relative path, or a real absolute filesystem path. Do not use /root; that is the agent namespace.",
        },
        offset: {
          type: "number",
          description: "Optional. Line number to start from (1-indexed).",
        },
        limit: {
          type: "number",
          description: "Optional. Max number of lines to return.",
        },
        pages: {
          type: "string",
          description: "Optional. Page range for PDF files (e.g. '1-5').",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    checkPermissions(input, context) {
      const args = input as FileReadInput;
      const filePath =
        typeof args.file_path === "string" ? args.file_path : "";
      if (filePath.trim().length === 0) {
        return {
          behavior: "ask",
          message: "file_path must be a non-empty string",
        };
      }
      const cwd =
        typeof args.cwd === "string" && args.cwd.length > 0
          ? args.cwd
          : config.allowedPaths[0] ?? process.cwd();
      if (isAgentNamespacePath(filePath)) {
        return denyAgentNamespacePath(filePath, cwd);
      }
      const decision = checkToolPathPermission({
        toolName: FILE_READ_TOOL_NAME,
        input: input as Record<string, unknown>,
        path: filePath,
        cwd,
        context: context.getAppState().toolPermissionContext,
        operationType: "read",
        extraWorkingDirectories: config.allowedPaths,
      });
      if (decision.behavior !== "allow") return decision;

      const currentInput =
        decision.updatedInput &&
        typeof decision.updatedInput === "object" &&
        !Array.isArray(decision.updatedInput)
          ? (decision.updatedInput as Record<string, unknown>)
          : (input as Record<string, unknown>);
      const absolutePath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
      return {
        ...decision,
        updatedInput: withSignedAllowedRoots(currentInput, [
          dirname(absolutePath),
        ]),
      };
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as FileReadInput;
      const filePath = typeof args.file_path === "string" ? args.file_path : "";
      if (filePath.trim().length === 0) {
        return errorResult("file_path must be a non-empty string");
      }
      const parsedOffset = parsePositiveIntArg(args.offset, "offset");
      if ("err" in parsedOffset) return parsedOffset.err;
      const parsedLimit = parsePositiveIntArg(args.limit, "limit");
      if ("err" in parsedLimit) return parsedLimit.err;
      const offset = parsedOffset.value ?? 1;
      const limit = parsedLimit.value;

      const ext = extname(filePath).toLowerCase();
      const isImage = IMAGE_EXTENSIONS.has(ext);
      const isPdf = ext === PDF_EXTENSION;
      const isNotebook = ext === NOTEBOOK_EXTENSION;

      // Pre-flight: any other binary extension is rejected *before* we
      // even resolve the path, so the model gets an actionable error
      // identical to AgenC's `errorCode: 4` branch.
      if (!isImage && !isPdf && hasBinaryExtension(filePath)) {
        return errorResult(
          `This tool cannot read binary files. The file appears to be a binary ${ext} file. Use a different tool for binary file analysis.`,
        );
      }

      const resolveResult = await resolveAndCheck(filePath, config, rawArgs);
      if ("err" in resolveResult) return resolveResult.err;
      const resolved = resolveResult.ok;

      const sessionId = resolveSessionId(rawArgs);

      try {
        if (isImage) {
          return await readImageFile(
            resolved,
            { displayPath: filePath, ext, maxImageBytes },
            sessionId,
          );
        }
        if (isPdf) {
          return await readPDFFile(
            resolved,
            {
              displayPath: filePath,
              maxPdfBytes,
              pages: args.pages,
              maxTokens,
              offset,
              limit,
            },
            sessionId,
          );
        }
        if (isNotebook) {
          return await readNotebookFile(
            resolved,
            {
              maxTextBytes,
              maxTokens,
              offset,
              limit,
              displayPath: filePath,
              maxImageBytes,
              maxNotebookBytes,
            },
            sessionId,
          );
        }
        return await readTextFile(
          resolved,
          {
            maxTextBytes,
            maxTokens,
            offset,
            limit,
            displayPath: filePath,
          },
          sessionId,
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") {
          return errorResult(`File does not exist: ${filePath}`);
        }
        if (code === "EACCES") {
          return errorResult(`Permission denied: ${filePath}`);
        }
        if (code === "EISDIR") {
          return errorResult(
            `Path is a directory, not a file: ${filePath}. Use a shell listing tool instead.`,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Read failed: ${message}`);
      }
    },
  };
}

/**
 * Read the env-var override for `maxTokens` (kept for AgenC
 * compatibility). Returns the supplied default if unset or invalid.
 */
function envOrDefault(fallback: number): number {
  const raw = process.env.AGENC_FILE_READ_MAX_OUTPUT_TOKENS;
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
