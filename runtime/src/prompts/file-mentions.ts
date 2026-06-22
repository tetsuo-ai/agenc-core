/**
 * File @mention support for interactive prompts.
 *
 * This module is intentionally UI-free so both the TUI composer and the
 * runtime submit path can share the same parsing, boundary checks, and
 * prompt expansion rules.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { isSupportedUserImagePath } from "./attachments/user-image-input.js";
import { isSupportedUserPdfPath } from "./attachments/user-pdf-input.js";
import { sanitizeSystemReminderContent } from "./attachments/system-reminder-sanitizer.js";
import { isRecord } from "../utils/record.js";

export type MentionValidationResult =
  | { ok: true; resolved: string }
  | { ok: false; reason: "outside_workspace" | "unreadable" };

export interface DetectedMention {
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly validation: MentionValidationResult;
}

export type FileMentionRejectionReason =
  | "outside_workspace"
  | "unreadable"
  | "not_file"
  | "too_large"
  | "too_many_files"
  | "total_too_large"
  | "binary";

export interface FileMentionRejection {
  readonly raw: string;
  readonly resolved?: string;
  readonly reason: FileMentionRejectionReason;
  readonly limit?: number;
}

export interface FileMentionAttachment {
  readonly raw: string;
  readonly path: string;
  readonly resolved: string;
  readonly canonicalResolved: string;
  readonly bytes: number;
  readonly lineCount: number;
  readonly truncated: boolean;
  readonly content: string;
  readonly rawContent: string;
  readonly mtimeMs: number;
}

export interface FileMentionExpansion {
  readonly prompt: string;
  readonly attachments: readonly FileMentionAttachment[];
  readonly rejected: readonly FileMentionRejection[];
}

export interface ExpandFileMentionsOptions {
  readonly cwd: string;
  readonly allowedRoots?: readonly string[];
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxLines?: number;
}

const EMPTY_MENTIONS: readonly DetectedMention[] = Object.freeze([]);

const FILE_MENTION_MAX_FILES = 10;
const FILE_MENTION_MAX_FILE_BYTES = 256 * 1024;
const FILE_MENTION_MAX_TOTAL_BYTES = 768 * 1024;
const FILE_MENTION_MAX_LINES = 4_000;

/**
 * Match prompt @mentions that begin at a token boundary and stop before
 * common trailing prose punctuation. Email addresses and mid-token @ signs
 * are deliberately ignored.
 */
const MENTION_REGEX = /(^|[\s([{])@([^\s,;:)"'`\]}<>]+)/g;

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeMentionPath(raw: string): string {
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

function trimTrailingMentionPunctuation(raw: string): string {
  return raw.replace(/[.!?]+$/u, "");
}

/**
 * Decide whether a `@mention` is allowed to resolve as an attachment:
 * relative paths resolve under `cwd`, absolute paths must be under `cwd`
 * or one of `allowedRoots`.
 */
export function validateMentionPath(
  raw: string,
  cwd: string,
  allowedRoots?: readonly string[],
): MentionValidationResult {
  try {
    const normalizedRaw = normalizeMentionPath(raw);
    const resolved = isAbsolute(normalizedRaw)
      ? resolve(normalizedRaw)
      : resolve(cwd, normalizedRaw);
    const cwdResolved = resolve(cwd);

    if (isInsideRoot(cwdResolved, resolved)) {
      return { ok: true, resolved };
    }

    for (const root of allowedRoots ?? []) {
      if (typeof root !== "string" || root.length === 0) continue;
      if (isInsideRoot(resolve(root), resolved)) {
        return { ok: true, resolved };
      }
    }

    return { ok: false, reason: "outside_workspace" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

export function scanMentions(
  value: string,
  cwd: string,
  allowedRoots?: readonly string[],
): DetectedMention[] {
  if (!value.includes("@")) {
    return EMPTY_MENTIONS as DetectedMention[];
  }

  const out: DetectedMention[] = [];
  const rx = new RegExp(MENTION_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = rx.exec(value)) !== null) {
    const prefix = match[1] ?? "";
    const matchedRaw = match[2];
    if (typeof matchedRaw !== "string" || matchedRaw.length === 0) continue;
    const raw = trimTrailingMentionPunctuation(matchedRaw);
    if (raw.length === 0) continue;
    const start = match.index + prefix.length;
    out.push({
      raw,
      start,
      end: start + raw.length + 1,
      validation: validateMentionPath(raw, cwd, allowedRoots),
    });
  }
  return out;
}

export function extractMentionAllowedRoots(
  config: unknown,
): readonly string[] | undefined {
  if (!isRecord(config)) return undefined;
  const direct = readAllowedRoots(config.attachments);
  if (direct !== undefined) return direct;
  if (isRecord(config._unknown)) {
    return readAllowedRoots(config._unknown.attachments);
  }
  return undefined;
}

function readAllowedRoots(value: unknown): readonly string[] | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value.allowedRoots ?? value.allowed_roots;
  if (!Array.isArray(raw)) return undefined;
  const roots = raw.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
  return roots.length > 0 ? roots : undefined;
}

async function resolveRealPath(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return resolve(path);
  }
}

async function buildRealAllowedRoots(
  cwd: string,
  allowedRoots?: readonly string[],
): Promise<readonly string[]> {
  const roots = [cwd, ...(allowedRoots ?? [])].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  const out: string[] = [];
  for (const root of roots) {
    out.push(await resolveRealPath(root));
  }
  return out;
}

export async function resolveAllowedFileMentionRealPath(
  resolvedPath: string,
  cwd: string,
  allowedRoots?: readonly string[],
): Promise<string | null> {
  let realTarget: string;
  try {
    realTarget = await fs.realpath(resolvedPath);
  } catch {
    return null;
  }
  const realAllowedRoots = await buildRealAllowedRoots(cwd, allowedRoots);
  return realAllowedRoots.some((root) => isInsideRoot(root, realTarget))
    ? realTarget
    : null;
}

function relativePromptPath(cwd: string, resolvedPath: string): string {
  const cwdResolved = resolve(cwd);
  const rel = relative(cwdResolved, resolvedPath);
  if (isInsideRoot(cwdResolved, resolvedPath)) {
    return rel.length > 0 ? rel : ".";
  }
  return resolvedPath;
}

function normalizeTextContent(content: string): string {
  return content.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
}

function containsBinaryNull(content: string): boolean {
  return content.slice(0, 8192).includes("\u0000");
}

function limitLines(
  content: string,
  maxLines: number,
): { readonly content: string; readonly lineCount: number; readonly truncated: boolean } {
  const lines = content.split("\n");
  if (lines.length <= maxLines) {
    return { content, lineCount: lines.length, truncated: false };
  }
  return {
    content: lines.slice(0, maxLines).join("\n"),
    lineCount: maxLines,
    truncated: true,
  };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeTagBody(value: string): string {
  return value
    .replace(/<\/attached_files>/gi, "<\\/attached_files>")
    .replace(/<\/user_message>/gi, "<\\/user_message>")
    .replace(/<\/file>/gi, "<\\/file>");
}

export function renderFileMentionAttachmentsBlock(
  attachments: readonly FileMentionAttachment[],
): string {
  const attachedFiles = attachments
    .map((attachment) => {
      const path = sanitizeSystemReminderContent(attachment.path);
      const content = sanitizeSystemReminderContent(attachment.content);
      const attrs = [
        `path="${escapeAttribute(path)}"`,
        `bytes="${attachment.bytes}"`,
        `lines="${attachment.lineCount}"`,
        `truncated="${attachment.truncated ? "true" : "false"}"`,
      ].join(" ");
      return `<file ${attrs}>\n${escapeTagBody(content)}\n</file>`;
    })
    .join("\n\n");

  return ["<attached_files>", attachedFiles, "</attached_files>"].join("\n");
}

function buildExpandedPrompt(
  userMessage: string,
  attachments: readonly FileMentionAttachment[],
): string {
  return [
    renderFileMentionAttachmentsBlock(attachments),
    "",
    "<user_message>",
    escapeTagBody(userMessage),
    "</user_message>",
  ].join("\n");
}

export async function expandFileMentions(
  input: string,
  options: ExpandFileMentionsOptions,
): Promise<FileMentionExpansion> {
  const maxFiles = options.maxFiles ?? FILE_MENTION_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? FILE_MENTION_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? FILE_MENTION_MAX_TOTAL_BYTES;
  const maxLines = options.maxLines ?? FILE_MENTION_MAX_LINES;
  const mentions = scanMentions(input, options.cwd, options.allowedRoots);
  const rejected: FileMentionRejection[] = [];
  const attachments: FileMentionAttachment[] = [];
  const seenResolved = new Set<string>();

  if (mentions.length === 0) {
    return { prompt: input, attachments, rejected };
  }

  const realAllowedRoots = await buildRealAllowedRoots(
    options.cwd,
    options.allowedRoots,
  );
  let totalBytes = 0;

  for (const mention of mentions) {
    if (!mention.validation.ok) {
      rejected.push({ raw: mention.raw, reason: mention.validation.reason });
      continue;
    }

    const resolved = mention.validation.resolved;
    if (seenResolved.has(resolved)) continue;

    if (attachments.length >= maxFiles) {
      rejected.push({
        raw: mention.raw,
        resolved,
        reason: "too_many_files",
        limit: maxFiles,
      });
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      rejected.push({ raw: mention.raw, resolved, reason: "unreadable" });
      continue;
    }

    if (!stat.isFile()) {
      rejected.push({ raw: mention.raw, resolved, reason: "not_file" });
      continue;
    }

    if (stat.size > maxFileBytes) {
      rejected.push({
        raw: mention.raw,
        resolved,
        reason: "too_large",
        limit: maxFileBytes,
      });
      continue;
    }

    let realTarget;
    try {
      realTarget = await fs.realpath(resolved);
    } catch {
      rejected.push({ raw: mention.raw, resolved, reason: "unreadable" });
      continue;
    }

    if (!realAllowedRoots.some((root) => isInsideRoot(root, realTarget))) {
      rejected.push({ raw: mention.raw, resolved, reason: "outside_workspace" });
      continue;
    }

    if (
      isSupportedUserImagePath(resolved) ||
      isSupportedUserPdfPath(resolved)
    ) {
      seenResolved.add(resolved);
      continue;
    }

    let rawText;
    try {
      rawText = await fs.readFile(resolved, "utf8");
    } catch {
      rejected.push({ raw: mention.raw, resolved, reason: "unreadable" });
      continue;
    }

    if (containsBinaryNull(rawText)) {
      rejected.push({ raw: mention.raw, resolved, reason: "binary" });
      continue;
    }

    const normalized = normalizeTextContent(rawText);
    const rawBytes = Buffer.byteLength(normalized, "utf8");
    if (rawBytes > maxFileBytes) {
      rejected.push({
        raw: mention.raw,
        resolved,
        reason: "too_large",
        limit: maxFileBytes,
      });
      continue;
    }
    if (totalBytes + rawBytes > maxTotalBytes) {
      rejected.push({
        raw: mention.raw,
        resolved,
        reason: "total_too_large",
        limit: maxTotalBytes,
      });
      continue;
    }

    const limited = limitLines(normalized, maxLines);
    totalBytes += rawBytes;
    seenResolved.add(resolved);
    attachments.push({
      raw: mention.raw,
      path: relativePromptPath(options.cwd, resolved),
      resolved,
      canonicalResolved: realTarget,
      bytes: rawBytes,
      lineCount: limited.lineCount,
      truncated: limited.truncated,
      content: limited.content,
      rawContent: normalized,
      mtimeMs:
        typeof stat.mtimeMs === "number" && Number.isFinite(stat.mtimeMs)
          ? stat.mtimeMs
          : Date.now(),
    });
  }

  return {
    prompt:
      attachments.length > 0 ? buildExpandedPrompt(input, attachments) : input,
    attachments,
    rejected,
  };
}

export function formatFileMentionRejection(
  rejection: FileMentionRejection,
): string {
  switch (rejection.reason) {
    case "outside_workspace":
      return `@${rejection.raw} is outside the workspace or allowed roots`;
    case "unreadable":
      return `@${rejection.raw} could not be read`;
    case "not_file":
      return `@${rejection.raw} is not a regular file`;
    case "too_large":
      return `@${rejection.raw} exceeds the per-file attachment limit`;
    case "too_many_files":
      return `@${rejection.raw} exceeds the per-turn file attachment count`;
    case "total_too_large":
      return `@${rejection.raw} exceeds the per-turn attachment byte limit`;
    case "binary":
      return `@${rejection.raw} appears to be binary`;
  }
  return `@${rejection.raw} could not be attached`;
}
