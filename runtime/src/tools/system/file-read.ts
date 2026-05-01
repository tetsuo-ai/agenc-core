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
 *   - `offset` / `limit` produce a partial line view. Partial reads
 *     are recorded with `viewKind: "partial"` in the session-read
 *     tracker so `Edit`/`Write`'s read-before-write gate still rejects
 *     edits made off a partial view.
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
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

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
} from "./filesystem.js";
import { checkToolPathPermission } from "../../permissions/path-validation.js";

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

/** Upstream PDF safety limits. */
const PDF_LARGE_PAGE_THRESHOLD = 10;
const PDF_MAX_PAGES_PER_REQUEST = 20;
const PDF_SUBPROCESS_TIMEOUT_MS = 120_000;

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

// ─────────────────────────────────────────────────────────────────────
// Description (model-facing)
// ─────────────────────────────────────────────────────────────────────

/**
 * AgenC file-read prompt template.
 * Image / PDF mentions are kept so the model knows the tool's capability
 * surface; the ipynb branch is dropped (AgenC does not currently parse
 * notebooks here).
 */
const FILE_READ_DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${DEFAULT_LINE_LIMIT} lines starting from the beginning of the file
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows AgenC to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually because AgenC can inspect multimodal inputs.
- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.
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
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Runtime-shape error envelope: plain text body, isError flag. */
function errorResult(message: string): ToolResult {
  return { content: message, isError: true };
}

/** Coerce optional finite numbers (model may emit ints as strings). */
function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (parsed >= 1) return parsed;
  }
  return undefined;
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
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
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

function parsePDFPageRange(
  pages: unknown,
): { firstPage: number; lastPage: number } | { err: string } | null {
  if (pages === undefined || pages === null) return null;
  if (typeof pages !== "string" || pages.trim().length === 0) {
    return { err: "pages must be a non-empty string when provided" };
  }

  const trimmed = pages.trim();
  if (trimmed.endsWith("-")) {
    const firstPage = Number.parseInt(trimmed.slice(0, -1), 10);
    if (!Number.isFinite(firstPage) || firstPage < 1) {
      return { err: `Invalid PDF page range: ${trimmed}` };
    }
    return { firstPage, lastPage: Infinity };
  }

  const dash = trimmed.indexOf("-");
  if (dash === -1) {
    const page = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(page) || page < 1) {
      return { err: `Invalid PDF page range: ${trimmed}` };
    }
    return { firstPage: page, lastPage: page };
  }

  const firstPage = Number.parseInt(trimmed.slice(0, dash), 10);
  const lastPage = Number.parseInt(trimmed.slice(dash + 1), 10);
  if (
    !Number.isFinite(firstPage) ||
    !Number.isFinite(lastPage) ||
    firstPage < 1 ||
    lastPage < firstPage
  ) {
    return { err: `Invalid PDF page range: ${trimmed}` };
  }
  return { firstPage, lastPage };
}

function pageRangeLength(range: { firstPage: number; lastPage: number }): number {
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
  if (fileStats.size > opts.maxTextBytes) {
    return errorResult(
      `File size ${formatBytes(fileStats.size)} exceeds the text-read limit of ${formatBytes(
        opts.maxTextBytes,
      )}. Use offset and limit to read a slice, or a different tool for large binary blobs.`,
    );
  }
  const buffer = await readFile(resolvedPath.canonical);
  if (isBinaryContent(buffer)) {
    return errorResult(
      "This tool cannot read binary files. The file contains non-text bytes. Use a different tool (e.g. a hex viewer or shell tooling) for binary file analysis.",
    );
  }

  const text = buffer.toString("utf-8");
  const sliced = sliceLines(text, opts.offset, opts.limit);

  // Token cap — match AgenC's MaxFileReadTokenExceededError
  // verbatim so any model-side recovery prompt still triggers.
  const estimated = estimateTokens(sliced.content);
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
    ...(sliced.isPartial ? {} : { rawContent: text }),
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

  const parsedRange = parsePDFPageRange(opts.pages);
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
  const estimated = estimateTokens(text);
  if (estimated > opts.maxTokens) {
    return errorResult(
      `PDF content (${estimated} tokens) exceeds maximum allowed tokens (${opts.maxTokens}). Provide a narrower pages range.`,
    );
  }

  recordSessionRead(sessionId, resolvedPath.canonical, {
    content: text,
    timestamp:
      typeof fileStats.mtimeMs === "number" && Number.isFinite(fileStats.mtimeMs)
        ? fileStats.mtimeMs
        : Date.now(),
    viewKind: parsedRange ? "partial" : "full",
    ...(parsedRange ? { readOffset: selectedRange?.firstPage ?? 1 } : {}),
    ...(parsedRange && selectedRange && selectedRange.lastPage !== Infinity
      ? { readLimit: pageRangeLength(selectedRange) }
      : {}),
    ...(parsedRange ? {} : { rawContent: text }),
  });

  if (text.length === 0) {
    return {
      content:
        "<system-reminder>Warning: the PDF exists but no extractable text was found.</system-reminder>",
      metadata: {
        filePath: opts.displayPath,
        mediaType: "application/pdf",
        totalPages: pageCount,
        isPartial: parsedRange !== null,
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
    content: `Read PDF ${opts.displayPath} (${rangeLabel})\n\n${text}`,
    metadata: {
      filePath: opts.displayPath,
      mediaType: "application/pdf",
      sizeBytes: fileStats.size,
      totalPages: pageCount,
      pageRange: rangeLabel,
      isPartial: parsedRange !== null,
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

  return {
    name: FILE_READ_TOOL_NAME,
    description: FILE_READ_DESCRIPTION,
    metadata: {
      family: "filesystem",
      source: "builtin",
      keywords: ["read", "file", "image", "view", "cat"],
      preferredProfiles: ["coding", "general", "operator"],
      hiddenByDefault: false,
      mutating: false,
      deferred: false,
    },
    isReadOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or workspace-relative path.",
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
      return checkToolPathPermission({
        toolName: FILE_READ_TOOL_NAME,
        input: input as Record<string, unknown>,
        path: filePath,
        cwd,
        context: context.getAppState().toolPermissionContext,
        operationType: "read",
        extraWorkingDirectories: config.allowedPaths,
      });
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as FileReadInput;
      const filePath = typeof args.file_path === "string" ? args.file_path : "";
      if (filePath.trim().length === 0) {
        return errorResult("file_path must be a non-empty string");
      }
      const offset = asPositiveInt(args.offset) ?? 1;
      const limit = asPositiveInt(args.limit);

      const ext = extname(filePath).toLowerCase();
      const isImage = IMAGE_EXTENSIONS.has(ext);
      const isPdf = ext === PDF_EXTENSION;

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

export default createFileReadTool;
