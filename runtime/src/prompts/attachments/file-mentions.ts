/**
 * File-mention attachment producer.
 *
 * Ports the upstream donor `src/utils/attachments.ts:2994-3230`
 * (`generateFileAttachment()` and the `at-mention` call path) onto
 * AgenC's existing prompt-safe `@path` resolver in
 * `runtime/src/prompts/file-mentions.ts`.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC already has UI-free path validation, root checks, and prompt
 *     rendering helpers; this producer wires those helpers into the
 *     per-turn attachment pipeline so every `Session.runTurn()` caller
 *     gets the same model-visible file context.
 *
 * @module
 */

import { stat } from "node:fs/promises";

import {
  expandFileMentions,
  resolveAllowedFileMentionRealPath,
  scanMentions,
} from "../file-mentions.js";
import {
  isSupportedUserImagePath,
  normalizeUserImageInput,
} from "./user-image-input.js";
import {
  isSupportedUserPdfPath,
  normalizeUserPdfInput,
} from "./user-pdf-input.js";
import type { AttachmentProducer } from "./orchestrator.js";
import type {
  FileMentionContextAttachment,
  ImageMentionContextAttachment,
  PdfMentionContextAttachment,
} from "./types.js";

export const IMAGE_MENTION_MAX_FILES = 10;
export const IMAGE_MENTION_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const IMAGE_MENTION_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const PDF_MENTION_MAX_FILES = 5;
export const PDF_MENTION_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const PDF_MENTION_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function alreadyContainsFileMentionContext(input: string): boolean {
  return (
    input.includes("<attached_files>") && input.includes("</attached_files>")
  );
}

function userMessageForMentionScan(input: string): string {
  if (!alreadyContainsFileMentionContext(input)) return input;
  const match = /<user_message>\n([\s\S]*?)\n<\/user_message>/iu.exec(input);
  return match?.[1] ?? input;
}

async function collectImageMentionAttachment(
  input: string,
  opts: Parameters<AttachmentProducer>[0],
): Promise<ImageMentionContextAttachment | null> {
  const mentions = scanMentions(input, opts.cwd, opts.fileMentionAllowedRoots);
  if (mentions.length === 0) return null;
  const seen = new Set<string>();
  const images: Array<ImageMentionContextAttachment["images"][number]> = [];
  let totalImageBytes = 0;

  for (const mention of mentions) {
    if (images.length >= IMAGE_MENTION_MAX_FILES) break;
    if (!mention.validation.ok) continue;
    const resolved = mention.validation.resolved;
    if (seen.has(resolved) || !isSupportedUserImagePath(resolved)) continue;
    if (
      (await resolveAllowedFileMentionRealPath(
        resolved,
        opts.cwd,
        opts.fileMentionAllowedRoots,
      )) === null
    ) {
      continue;
    }
    const fileStat = await stat(resolved).catch(() => null);
    if (
      fileStat === null ||
      !fileStat.isFile() ||
      fileStat.size <= 0 ||
      fileStat.size > IMAGE_MENTION_MAX_FILE_BYTES ||
      totalImageBytes + fileStat.size > IMAGE_MENTION_MAX_TOTAL_BYTES
    ) {
      continue;
    }
    const image = normalizeUserImageInput(resolved, opts.cwd);
    if (image === null || image.mediaType === undefined) continue;
    seen.add(resolved);
    totalImageBytes += fileStat.size;
    images.push({
      raw: mention.raw,
      path: mention.raw,
      resolved,
      mediaType: image.mediaType,
      url: image.content,
    });
  }

  return images.length > 0 ? { kind: "image_mention", images } : null;
}

async function collectPdfMentionAttachment(
  input: string,
  opts: Parameters<AttachmentProducer>[0],
): Promise<PdfMentionContextAttachment | null> {
  const mentions = scanMentions(input, opts.cwd, opts.fileMentionAllowedRoots);
  if (mentions.length === 0) return null;
  const seen = new Set<string>();
  const pdfs: Array<PdfMentionContextAttachment["pdfs"][number]> = [];
  let totalPdfBytes = 0;

  for (const mention of mentions) {
    if (pdfs.length >= PDF_MENTION_MAX_FILES) break;
    if (!mention.validation.ok) continue;
    const resolved = mention.validation.resolved;
    if (seen.has(resolved) || !isSupportedUserPdfPath(resolved)) continue;
    if (
      (await resolveAllowedFileMentionRealPath(
        resolved,
        opts.cwd,
        opts.fileMentionAllowedRoots,
      )) === null
    ) {
      continue;
    }
    const fileStat = await stat(resolved).catch(() => null);
    if (
      fileStat === null ||
      !fileStat.isFile() ||
      fileStat.size <= 0 ||
      fileStat.size > PDF_MENTION_MAX_FILE_BYTES ||
      totalPdfBytes + fileStat.size > PDF_MENTION_MAX_TOTAL_BYTES
    ) {
      continue;
    }
    const pdf = await normalizeUserPdfInput(resolved);
    if (pdf === null) continue;
    seen.add(resolved);
    totalPdfBytes += fileStat.size;
    pdfs.push({
      raw: mention.raw,
      path: mention.raw,
      resolved,
      mediaType: pdf.mediaType,
      data: pdf.data,
      bytes: pdf.bytes,
      filename: pdf.filename,
      ...(pdf.fallbackText !== undefined
        ? {
            fallbackText: pdf.fallbackText,
            fallbackTextTruncated: pdf.fallbackTextTruncated ?? false,
          }
        : {}),
      ...(pdf.fallbackTextError !== undefined
        ? { fallbackTextError: pdf.fallbackTextError }
        : {}),
    });
  }

  return pdfs.length > 0 ? { kind: "pdf_mention", pdfs } : null;
}

export const fileMentionsProducer: AttachmentProducer = async (opts) => {
  const input = opts.userInput;
  if (opts.signal.aborted || input === null || !input.includes("@")) {
    return [];
  }
  const mentionInput = userMessageForMentionScan(input);

  const out: Array<
    | FileMentionContextAttachment
    | ImageMentionContextAttachment
    | PdfMentionContextAttachment
  > = [];
  if (!alreadyContainsFileMentionContext(input)) {
    const expansion = await expandFileMentions(input, {
      cwd: opts.cwd,
      allowedRoots: opts.fileMentionAllowedRoots,
    });
    if (expansion.attachments.length > 0) {
      out.push({
        kind: "file_mention",
        files: expansion.attachments,
      });
    }
  }

  const imageAttachment = await collectImageMentionAttachment(mentionInput, opts);
  if (imageAttachment !== null) out.push(imageAttachment);
  const pdfAttachment = await collectPdfMentionAttachment(mentionInput, opts);
  if (pdfAttachment !== null) out.push(pdfAttachment);
  return out;
};
