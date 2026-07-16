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
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
  type SandboxSpawnCommand,
} from "../../sandbox/execution-broker.js";
import { scrubEnvForChildProcess } from "../../unified-exec/scrub-env.js";
import { runSupervisedProcess } from "../../utils/supervisedProcess.js";

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
const PDF_TEXT_EXTRACTION_PROCESS_MAX_BYTES =
  PDF_TEXT_EXTRACTION_MAX_BYTES + 256 * 1024;

export interface UserPdfNormalizationOptions {
  readonly cwd?: string;
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
}

export function isSupportedUserPdfPath(filePath: string): boolean {
  return PDF_FILE_RE.test(filePath);
}

export async function normalizeUserPdfInput(
  input: string,
  options: UserPdfNormalizationOptions = {},
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
    const extracted = await extractPdfText(input, options);
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

async function extractPdfText(
  filePath: string,
  options: UserPdfNormalizationOptions,
): Promise<
  | { readonly kind: "ok"; readonly text: string; readonly truncated: boolean }
  | { readonly kind: "error"; readonly error: string }
> {
  let result: Awaited<ReturnType<typeof runPdfTextExtractor>>;
  try {
    result = await runPdfTextExtractor(filePath, options);
  } catch (error) {
    return {
      kind: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

async function runPdfTextExtractor(
  filePath: string,
  options: UserPdfNormalizationOptions,
): Promise<
  | {
      readonly kind: "ok";
      readonly stdout: readonly Buffer[];
      readonly truncated: boolean;
    }
  | { readonly kind: "error"; readonly error: string }
> {
  if (options.sandboxExecutionBroker === undefined) {
    throw missingSandboxExecutionBoundary("tool");
  }
  let command: SandboxSpawnCommand;
  try {
    command = options.sandboxExecutionBroker.prepareSpawn("tool", {
      program: "pdftotext",
      args: ["-layout", "-nopgbrk", "-q", filePath, "-"],
      cwd: options.cwd ?? path.dirname(filePath),
      env: scrubEnvForChildProcess(process.env),
    });
  } catch (error) {
    if (isExecutableUnavailable(error)) {
      return {
        kind: "error",
        error: pdfExtractionErrorMessage({ code: "ENOENT" }),
      };
    }
    throw error;
  }
  let stdoutBytes = 0;
  let exceededTextLimit = false;
  const result = await runSupervisedProcess(command, {
    timeoutMs: PDF_TEXT_EXTRACTION_TIMEOUT_MS,
    maxOutputBytes: PDF_TEXT_EXTRACTION_PROCESS_MAX_BYTES,
    onStdout: (chunk, control) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > PDF_TEXT_EXTRACTION_MAX_BYTES) {
        exceededTextLimit = true;
        control.stop();
      }
    },
  });

  const stdout = result.stdout.subarray(0, PDF_TEXT_EXTRACTION_MAX_BYTES);
  const truncated =
    exceededTextLimit ||
    (result.stopReason === "output_limit" &&
      result.stdout.byteLength >= PDF_TEXT_EXTRACTION_MAX_BYTES);
  if (truncated) {
    return { kind: "ok", stdout: [stdout], truncated: true };
  }
  if (result.stopReason === "timeout") {
    return { kind: "error", error: "PDF text extraction timed out." };
  }
  if (result.error !== undefined) {
    return {
      kind: "error",
      error: pdfExtractionErrorMessage(result.error),
    };
  }
  if (result.stopReason === "output_limit") {
    return {
      kind: "error",
      error: "PDF text extraction exceeded its output limit.",
    };
  }
  if (result.exitCode === 0) {
    return { kind: "ok", stdout: [stdout], truncated: false };
  }
  return {
    kind: "error",
    error: pdfExtractionErrorMessage({
      stderr: result.stderr.toString("utf8"),
    }),
  };
}

function isExecutableUnavailable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (/executable not found or not executable:/u.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
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
