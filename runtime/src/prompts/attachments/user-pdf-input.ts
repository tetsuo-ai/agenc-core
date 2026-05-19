/**
 * Ports the upstream attachment donor's PDF extension and raw-byte validation
 * (`utils/pdfUtils.ts::isPDFExtension`, `utils/pdf.ts::readPDF`) onto the
 * prompt attachment path.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC keeps UI-free prompt normalization beside image input handling.
 *     Provider-specific serialization happens later in the LLM wire layer.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Page rasterization and large-PDF page extraction stay owned by the
 *     FileRead tool; @mention attachments pass through compact PDFs directly
 *     and carry best-effort extracted text for non-native provider fallbacks.
 *
 * @module
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type NormalizedUserPdfInput = {
  readonly kind: "local";
  readonly source: string;
  readonly data: string;
  readonly mediaType: "application/pdf";
  readonly filename: string;
  readonly sourcePath: string;
  readonly bytes: number;
  readonly fallbackText?: string;
  readonly fallbackTextTruncated?: boolean;
  readonly fallbackTextError?: string;
};

const PDF_FILE_RE = /\.pdf$/iu;
const PDF_MEDIA_TYPE = "application/pdf";
const PDF_MAGIC = "%PDF-";

export const PDF_TEXT_EXTRACTION_MAX_BYTES = 256 * 1024;
const PDF_TEXT_EXTRACTION_TIMEOUT_MS = 120_000;

export function isSupportedUserPdfPath(filePath: string): boolean {
  return PDF_FILE_RE.test(filePath);
}

export async function normalizeUserPdfInput(
  input: string,
): Promise<NormalizedUserPdfInput | null> {
  if (!PDF_FILE_RE.test(input)) return null;
  try {
    if (!existsSync(input)) return null;
    const fileStat = statSync(input);
    if (!fileStat.isFile() || fileStat.size <= 0) return null;
    const bytes = readFileSync(input);
    if (bytes.byteLength === 0) return null;
    if (
      !bytes
        .subarray(0, PDF_MAGIC.length)
        .toString("utf8")
        .startsWith(PDF_MAGIC)
    ) {
      return null;
    }
    const extracted = await extractPdfText(input);
    return {
      kind: "local",
      source: input,
      data: bytes.toString("base64"),
      mediaType: PDF_MEDIA_TYPE,
      filename: path.basename(input),
      sourcePath: input,
      bytes: fileStat.size,
      ...(extracted.kind === "ok"
        ? {
            fallbackText: extracted.text,
            fallbackTextTruncated: extracted.truncated,
          }
        : { fallbackTextError: extracted.error }),
    };
  } catch {
    return null;
  }
}

async function extractPdfText(filePath: string): Promise<
  | { readonly kind: "ok"; readonly text: string; readonly truncated: boolean }
  | { readonly kind: "error"; readonly error: string }
> {
  const result = await runPdfTextExtractor(filePath);
  if (result.kind === "error") return result;
  const text = normalizeExtractedText(Buffer.concat(result.stdout));
  if (text.length === 0) {
    return {
      kind: "ok",
      text:
        "<system-reminder>Warning: the PDF exists but no extractable text was found.</system-reminder>",
      truncated: false,
    };
  }
  const truncated = truncateExtractedText(text, PDF_TEXT_EXTRACTION_MAX_BYTES);
  return {
    ...truncated,
    truncated: truncated.truncated || result.truncated,
  };
}

function runPdfTextExtractor(filePath: string): Promise<
  | {
      readonly kind: "ok";
      readonly stdout: readonly Buffer[];
      readonly truncated: boolean;
    }
  | { readonly kind: "error"; readonly error: string }
> {
  return new Promise((resolve) => {
    const child = spawn(
      "pdftotext",
      ["-layout", "-nopgbrk", "-q", filePath, "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, PDF_TEXT_EXTRACTION_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= PDF_TEXT_EXTRACTION_MAX_BYTES) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      const remaining = PDF_TEXT_EXTRACTION_MAX_BYTES - stdoutBytes;
      if (chunk.byteLength > remaining) {
        stdout.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.byteLength;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: "error", error: pdfExtractionErrorMessage(error) });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (truncated) {
        resolve({ kind: "ok", stdout, truncated: true });
        return;
      }
      if (timedOut) {
        resolve({ kind: "error", error: "PDF text extraction timed out." });
        return;
      }
      if (code === 0) {
        resolve({ kind: "ok", stdout, truncated: false });
        return;
      }
      resolve({
        kind: "error",
        error: pdfExtractionErrorMessage({
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      });
    });
  });
}

function normalizeExtractedText(value: Buffer): string {
  return value.toString("utf8").replace(/\r\n?/gu, "\n").trimEnd();
}

function truncateExtractedText(
  text: string,
  maxBytes: number,
): { readonly kind: "ok"; readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { kind: "ok", text, truncated: false };
  const truncated = Buffer.from(text, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "")
    .trimEnd();
  return { kind: "ok", text: truncated, truncated: true };
}

function pdfExtractionErrorMessage(error: unknown): string {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
  if (stderr.length > 0) return stderr;
  const code = String(record.code ?? "");
  if (code === "ENOENT") {
    return "PDF text extraction unavailable: install poppler-utils (`pdftotext`) to enable text fallback.";
  }
  if (String(record.killed ?? "") === "true") {
    return "PDF text extraction timed out.";
  }
  return "PDF text extraction failed.";
}
