import type { ProviderEnvironment } from "../llm/provider-options.js";
import { API_IMAGE_MAX_BASE64_SIZE } from "../constants/apiLimits.js";
import type { FunctionCallOutputContentItem } from "../tools/context.js";
import { inspectImageBytes } from "../utils/image-validation.js";
import { maybeResizeAndDownsampleImageBuffer } from "../utils/imageResizer.js";
import {
  getBinaryBlobSavedMessage,
  persistBinaryContent,
} from "../utils/mcpOutputStorage.js";
import {
  mcpContentNeedsTruncation,
  truncateMcpContentIfNeeded,
} from "../utils/mcpValidation.js";
import { asRecord } from "../utils/record.js";
import {
  buildLargeToolResultMessage,
  isPersistError,
  persistToolResult,
} from "../utils/toolResultStorage.js";
import type { Logger } from "./_deps/logger.js";
import type { ToolResult } from "./_deps/tools-types.js";
import { DISPLAY_ATTACHMENT_LIMIT, DISPLAY_BINARY_LIMIT, DISPLAY_WORK_LIMIT, DisplayValidationError, peekDisplayArtifactBytes, releaseDisplayArtifactBytes, validateDisplayBlock, withDisplayAttachmentTitle, type DisplayAttachment } from "./display-attachments.js";
import { redactMcpAttachmentText, redactMcpAttachmentValue } from "./local-control.js";
import {
  consumeMcpSanitizationBudget,
  createMcpSanitizationBudget,
  sanitizeMcpJsonValue,
  sanitizeMcpOutputText,
  truncateMcpUtf8,
  type McpSanitizationBudget,
} from "./content-sanitization.js";

/** One aggregate untrusted-work envelope for an MCP CallToolResult. */
export const MCP_TOOL_RESULT_HARD_LIMIT_BYTES = 5 * 1024 * 1024;
export const MAX_MCP_TOOL_RESULT_CONTENT_BLOCKS = 1_024;
export const MAX_MCP_BASE64_INSPECTION_BYTES = 8 * 1024 * 1024;
const MAX_MCP_INLINE_IMAGE_BYTES_PER_RESULT = 4 * 1024 * 1024;
const MAX_DISPLAY_INLINE_COMPLETION_BYTES = 3.5 * 1024 * 1024;

const MAX_MCP_META_BYTES = 64 * 1024;
const MAX_MCP_META_NODES = 4_096;
const HARD_LIMIT_MARKER =
  "\n\n[OUTPUT TRUNCATED: MCP tool result exceeded the 5 MiB safety limit]";
const WORK_LIMIT_MARKER =
  "[Additional MCP output omitted: aggregate safety budget exhausted]";
const BINARY_OMITTED = "[Invalid or oversized MCP binary content omitted]";
const IMAGE_OMITTED = "[MCP image omitted: invalid, unsupported, or oversized image]";
const MAX_MCP_IMAGES_PER_RESULT = 4;

interface BinaryArtifact {
  readonly filepath: string;
  readonly mimeType?: string;
  readonly size: number;
  readonly contentType: string;
}

export interface NormalizeMcpToolOutputOptions {
  readonly raw: unknown;
  /** Original plugin result retained solely for decisions and authorized file reads. */
  readonly originalRaw?: unknown;
  readonly serverName: string;
  readonly toolName: string;
  readonly callId: string;
  readonly environment: ProviderEnvironment;
  readonly logger: Logger;
  /** Trusted roots supplied by the plugin bridge, never from MCP output. */
  readonly displayRoots?: readonly string[];
  readonly displayDataRoot?: string;
  readonly sensitiveHeaders?: Readonly<Record<string, string>>;
}

function containsLiteralSecret(bytes: Buffer, headers?: Readonly<Record<string, string>>): boolean {
  for (const value of Object.values(headers ?? {})) {
    for (const secret of [value, value.replace(/^Bearer\s+/i, "")]) {
      if (secret.length < 4) continue;
      // JSON bytes (a chart or table, a .json file) hold the escaped form.
      for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
        if (bytes.includes(Buffer.from(form, "utf8"))) return true;
      }
    }
  }
  return false;
}

/** Chart/table JSON is redacted structurally before validation. Binary bytes
 * must be checked after the authorized read, before an attachment is emitted. */
function displayContainsLiteralSecret(attachment: DisplayAttachment, headers?: Readonly<Record<string, string>>): boolean {
  if (headers === undefined) return false;
  const bytes = peekDisplayArtifactBytes(attachment);
  return attachment.kind !== "chart" && attachment.kind !== "table" && bytes !== undefined && containsLiteralSecret(bytes, headers);
}

function containsEncodedLiteralSecret(encoded: unknown, headers?: Readonly<Record<string, string>>): boolean {
  if (typeof encoded !== "string" || encoded.length > MAX_MCP_BASE64_INSPECTION_BYTES) return false;
  for (const value of Object.values(headers ?? {})) {
    for (const secret of [value, value.replace(/^Bearer\s+/i, "")]) {
      if (secret.length >= 4 && encoded.includes(secret)) return true;
    }
  }
  return false;
}

interface RenderState {
  readonly budget: McpSanitizationBudget;
  readonly safeContentBlocks: Array<Record<string, unknown>>;
  readonly textParts: string[];
  readonly binaryArtifacts: BinaryArtifact[];
  readonly contentItems: FunctionCallOutputContentItem[];
  readonly displayAttachments: DisplayAttachment[];
  imageUrlBytes: number;
  binaryBytes: number;
  imagesProcessed: number;
  base64InspectedBytes: number;
  contentBlocksProcessed: number;
  omitted: boolean;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function hardBoundText(value: string): {
  readonly content: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
} {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= MCP_TOOL_RESULT_HARD_LIMIT_BYTES) {
    return { content: value, originalBytes, truncated: false };
  }
  const markerBytes = Buffer.byteLength(HARD_LIMIT_MARKER, "utf8");
  const prefix = truncateMcpUtf8(
    value,
    Math.max(0, MCP_TOOL_RESULT_HARD_LIMIT_BYTES - markerBytes),
  );
  return {
    content: `${prefix}${HARD_LIMIT_MARKER}`,
    originalBytes,
    truncated: true,
  };
}

function appendStaticText(state: RenderState, text: string): void {
  const safe = sanitizeMcpOutputText(text);
  state.textParts.push(safe);
  state.safeContentBlocks.push({ type: "text", text: safe });
  state.contentItems.push({ type: "input_text", text: safe });
}

function consumeSanitizedText(
  state: RenderState,
  raw: string,
): string | undefined {
  if (state.budget.remainingBytes <= 0) {
    state.omitted = true;
    return undefined;
  }

  const retainedRaw = truncateMcpUtf8(raw, state.budget.remainingBytes);
  const rawBytes = Buffer.byteLength(retainedRaw, "utf8");
  if (
    !consumeMcpSanitizationBudget(state.budget, rawBytes) ||
    (retainedRaw.length === 0 && raw.length > 0)
  ) {
    state.omitted = true;
    return undefined;
  }
  if (retainedRaw.length < raw.length) state.omitted = true;

  const sanitized = sanitizeMcpOutputText(retainedRaw);
  return truncateMcpUtf8(sanitized, rawBytes);
}

function appendUntrustedText(state: RenderState, raw: string): void {
  const safe = consumeSanitizedText(state, raw);
  if (safe === undefined) return;
  state.textParts.push(safe);
  state.safeContentBlocks.push({ type: "text", text: safe });
  state.contentItems.push({ type: "input_text", text: safe });
}

function appendPrimitiveContent(state: RenderState, value: unknown): void {
  if (typeof value === "string") {
    appendUntrustedText(state, value);
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    appendUntrustedText(
      state,
      typeof value === "number" && !Number.isFinite(value)
        ? "null"
        : JSON.stringify(value),
    );
    return;
  }
  appendStaticText(state, "[Unsupported MCP content value omitted]");
  state.omitted = true;
}

function sanitizeMimeType(
  state: RenderState,
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  const sanitized = consumeSanitizedText(state, value)?.trim();
  if (sanitized === undefined) return undefined;
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:\s*;[^\r\n]{0,96})?$/u
      .test(sanitized)
    ? sanitized
    : undefined;
}

function decodeBase64WithinBudget(
  state: RenderState,
  value: unknown,
): Buffer | undefined {
  if (typeof value !== "string") return undefined;
  const inspectRemaining = Math.min(
    state.budget.remainingBytes,
    MAX_MCP_BASE64_INSPECTION_BYTES - state.base64InspectedBytes,
  );
  if (inspectRemaining <= 0) {
    state.omitted = true;
    return undefined;
  }

  // Base64 is ASCII. Reject over-budget strings before trimming, regex work,
  // or decoding so repeated invalid blocks cannot multiply CPU/memory work.
  if (value.length > inspectRemaining) {
    consumeMcpSanitizationBudget(state.budget, inspectRemaining);
    state.base64InspectedBytes += inspectRemaining;
    state.omitted = true;
    return undefined;
  }
  const inspectedBytes = Buffer.byteLength(value, "utf8");
  if (
    inspectedBytes > inspectRemaining ||
    !consumeMcpSanitizationBudget(state.budget, inspectedBytes)
  ) {
    state.omitted = true;
    return undefined;
  }
  state.base64InspectedBytes += inspectedBytes;

  const encoded = value.trim();
  if (encoded.length === 0 || encoded.length % 4 === 1) return undefined;
  const padded = `${encoded}${"=".repeat((4 - (encoded.length % 4)) % 4)}`;
  // Repeated capture groups can overflow V8's regexp stack on a valid
  // multi-megabyte image. Scan once before the canonical round trip below.
  for (let index = 0; index < padded.length; index += 1) {
    const char = padded.charCodeAt(index);
    if (
      !((char >= 65 && char <= 90) ||
        (char >= 97 && char <= 122) ||
        (char >= 48 && char <= 57) ||
        char === 43 || char === 47 || char === 61)
    ) return undefined;
  }

  const decoded = Buffer.from(padded, "base64");
  const canonicalInput = padded.replace(/=+$/u, "");
  const canonicalDecoded = decoded.toString("base64").replace(/=+$/u, "");
  return canonicalDecoded === canonicalInput ? decoded : undefined;
}

async function appendBinary(
  state: RenderState,
  record: Record<string, unknown>,
  contentType: string,
  index: number,
  options: NormalizeMcpToolOutputOptions,
): Promise<void> {
  const encoded = record.data ?? record.blob;
  if (containsEncodedLiteralSecret(encoded, options.sensitiveHeaders)) {
    appendStaticText(state, `[MCP ${contentType} omitted: contained a saved secret]`);
    state.omitted = true;
    return;
  }
  const bytes = decodeBase64WithinBudget(state, encoded);
  const mimeType = sanitizeMimeType(
    state,
    record.mimeType ?? record.mediaType,
  );
  if (bytes === undefined) {
    appendStaticText(state, `${BINARY_OMITTED} (${contentType})`);
    options.logger.warn?.(
      `MCP tool ${JSON.stringify(options.toolName)} returned invalid or oversized ${contentType} content; omitted`,
    );
    return;
  }
  // Binary bytes cannot be rewritten without corrupting them. Omit a blob
  // whose decoded text contains a literal saved secret before persistence.
  if (containsLiteralSecret(bytes, options.sensitiveHeaders)) {
    appendStaticText(state, `[MCP ${contentType} omitted: contained a saved secret]`);
    state.omitted = true;
    return;
  }

  const persisted = await persistBinaryContent(
    bytes,
    mimeType,
    `${options.callId}-binary-${index}`,
  );
  if ("error" in persisted) {
    appendStaticText(
      state,
      `[MCP ${contentType} could not be persisted: ${sanitizeMcpOutputText(persisted.error)}]`,
    );
    return;
  }

  state.binaryBytes += bytes.byteLength;
  state.binaryArtifacts.push({
    filepath: persisted.filepath,
    ...(mimeType !== undefined ? { mimeType } : {}),
    size: persisted.size,
    contentType,
  });
  appendStaticText(
    state,
    getBinaryBlobSavedMessage(
      persisted.filepath,
      mimeType,
      persisted.size,
      `MCP ${contentType}: `,
    ),
  );
}

async function appendImage(
  state: RenderState,
  record: Record<string, unknown>,
  index: number,
  options: NormalizeMcpToolOutputOptions,
): Promise<void> {
  const encoded = record.data ?? record.blob;
  if (
    state.imagesProcessed >= MAX_MCP_IMAGES_PER_RESULT ||
    typeof encoded !== "string" ||
    encoded.length > MAX_MCP_BASE64_INSPECTION_BYTES
  ) {
    appendStaticText(state, IMAGE_OMITTED);
    return;
  }
  state.imagesProcessed += 1;

  if (containsEncodedLiteralSecret(encoded, options.sensitiveHeaders)) {
    appendStaticText(state, "[MCP image omitted: contained a saved secret]");
    state.omitted = true;
    return;
  }

  const bytes = decodeBase64WithinBudget(state, encoded);
  const rawDeclaredMime = record.mimeType ?? record.mediaType;
  const declaredMime = rawDeclaredMime === undefined
    ? undefined
    : sanitizeMimeType(state, rawDeclaredMime);
  if (bytes === undefined) {
    appendStaticText(state, IMAGE_OMITTED);
    return;
  }
  if (containsLiteralSecret(bytes, options.sensitiveHeaders)) {
    appendStaticText(state, "[MCP image omitted: contained a saved secret]");
    state.omitted = true;
    return;
  }
  const inspection = inspectImageBytes(bytes);
  const normalizedDeclaredMime = declaredMime?.split(";", 1)[0]?.trim().toLowerCase()
    .replace(/^image\/jpg$/u, "image/jpeg");
  if (
    !inspection.ok ||
    (rawDeclaredMime !== undefined && declaredMime === undefined) ||
    (declaredMime !== undefined && normalizedDeclaredMime !== inspection.mediaType)
  ) {
    appendStaticText(state, IMAGE_OMITTED);
    return;
  }

  let image: Awaited<ReturnType<typeof maybeResizeAndDownsampleImageBuffer>>;
  try {
    image = await maybeResizeAndDownsampleImageBuffer(
      bytes,
      bytes.length,
      inspection.format,
    );
  } catch {
    appendStaticText(state, IMAGE_OMITTED);
    return;
  }
  const mediaType = `image/${image.mediaType}`;
  const base64 = image.buffer.toString("base64");
  if (
    !/^(?:image\/(?:png|jpeg|gif|webp))$/u.test(mediaType) ||
    base64.length > API_IMAGE_MAX_BASE64_SIZE
  ) {
    appendStaticText(state, IMAGE_OMITTED);
    return;
  }
  const imageUrl = `data:${mediaType};base64,${base64}`;
  const imageUrlBytes = Buffer.byteLength(imageUrl, "utf8");
  if (state.imageUrlBytes + imageUrlBytes > MAX_MCP_INLINE_IMAGE_BYTES_PER_RESULT) {
    appendStaticText(state, IMAGE_OMITTED);
    return;
  }

  const persisted = await persistBinaryContent(
    bytes,
    inspection.mediaType,
    `${options.callId}-binary-${index}`,
  );
  if ("error" in persisted) {
    appendStaticText(state, "[MCP image could not be persisted]");
    return;
  }
  state.imageUrlBytes += imageUrlBytes;
  state.binaryBytes += bytes.byteLength;
  state.binaryArtifacts.push({
    filepath: persisted.filepath,
    mimeType: inspection.mediaType,
    size: persisted.size,
    contentType: "image",
  });
  appendStaticText(
    state,
    getBinaryBlobSavedMessage(
      persisted.filepath,
      inspection.mediaType,
      persisted.size,
      "MCP image: ",
    ),
  );
  state.contentItems.push({ type: "input_image", image_url: imageUrl });
}

async function appendResource(
  state: RenderState,
  record: Record<string, unknown>,
  index: number,
  options: NormalizeMcpToolOutputOptions,
): Promise<void> {
  const resource = asRecord(record.resource);
  if (resource === null) {
    appendStaticText(state, "[Invalid MCP resource content omitted]");
    state.omitted = true;
    return;
  }

  const uri = typeof resource.uri === "string"
    ? consumeSanitizedText(state, resource.uri) ?? "unknown URI"
    : "unknown URI";
  if (typeof resource.text === "string") {
    const text = consumeSanitizedText(state, resource.text);
    appendStaticText(
      state,
      text === undefined
        ? `MCP resource ${uri}: ${WORK_LIMIT_MARKER}`
        : `MCP resource ${uri}:\n${text}`,
    );
    return;
  }
  if (resource.blob !== undefined) {
    await appendBinary(
      state,
      { blob: resource.blob, mimeType: resource.mimeType },
      "resource",
      index,
      options,
    );
    return;
  }
  appendStaticText(state, `[Empty MCP resource returned for ${uri}]`);
}

function appendResourceLink(
  state: RenderState,
  record: Record<string, unknown>,
): void {
  const uri = typeof record.uri === "string"
    ? consumeSanitizedText(state, record.uri) ?? "unknown URI"
    : "unknown URI";
  const name = typeof record.name === "string"
    ? consumeSanitizedText(state, record.name) ?? "resource"
    : "resource";
  appendStaticText(state, `MCP resource link: ${name} (${uri})`);
}

async function renderContentBlock(
  state: RenderState,
  raw: unknown,
  index: number,
  options: NormalizeMcpToolOutputOptions,
): Promise<void> {
  if (!consumeMcpSanitizationBudget(state.budget, 0)) {
    state.omitted = true;
    return;
  }
  const record = asRecord(raw);
  if (record === null) {
    appendPrimitiveContent(state, raw);
    return;
  }

  switch (record.type) {
    case "text":
      if (typeof record.text === "string") {
        appendUntrustedText(state, record.text);
      } else {
        appendStaticText(state, "[Invalid MCP text content omitted]");
        state.omitted = true;
      }
      return;
    case "image":
      await appendImage(state, record, index, options);
      return;
    case "audio":
      await appendBinary(state, record, "audio", index, options);
      return;
    case "resource":
      await appendResource(state, record, index, options);
      return;
    case "resource_link":
      appendResourceLink(state, record);
      return;
    default: {
      const label = typeof record.type === "string" && record.type.length <= 128
        ? consumeSanitizedText(state, record.type) ?? "unknown"
        : "unknown";
      appendStaticText(state, `[Unsupported MCP content block omitted: ${label}]`);
      state.omitted = true;
    }
  }
}

function sanitizeStructuredValue(
  value: unknown,
  budget: McpSanitizationBudget,
): {
  readonly value?: unknown;
  readonly serialized?: string;
  readonly omitted: boolean;
} {
  const sanitized = sanitizeMcpJsonValue(value, 64, budget);
  const serialized = safeJson(sanitized);
  if (sanitized === undefined || serialized === undefined) {
    return { omitted: true };
  }
  return { value: sanitized, serialized, omitted: false };
}

function sanitizeMetaValue(
  value: unknown,
  sharedBudget: McpSanitizationBudget,
): { readonly value?: unknown; readonly omitted: boolean } {
  const metaBudget = createMcpSanitizationBudget(
    Math.min(MAX_MCP_META_BYTES, sharedBudget.remainingBytes),
    Math.min(MAX_MCP_META_NODES, sharedBudget.remainingNodes),
  );
  const startingBytes = metaBudget.remainingBytes;
  const startingNodes = metaBudget.remainingNodes;
  const sanitized = sanitizeMcpJsonValue(value, 32, metaBudget);
  const usedBytes = startingBytes - metaBudget.remainingBytes;
  const usedNodes = startingNodes - metaBudget.remainingNodes;
  if (!consumeMcpSanitizationBudget(sharedBudget, usedBytes, usedNodes)) {
    return { omitted: true };
  }
  if (sanitized === undefined) return { omitted: true };
  return { value: sanitized, omitted: false };
}

function boundedCodeModeResult(
  candidate: Record<string, unknown>,
  fallbackContent: string,
  isError: boolean,
): unknown {
  const serialized = safeJson(candidate);
  if (
    serialized !== undefined &&
    Buffer.byteLength(serialized, "utf8") <= MCP_TOOL_RESULT_HARD_LIMIT_BYTES
  ) {
    return candidate;
  }

  let low = 0;
  let high = Math.min(
    Buffer.byteLength(fallbackContent, "utf8"),
    MCP_TOOL_RESULT_HARD_LIMIT_BYTES,
  );
  let boundedFallback: Record<string, unknown> = {
    content: [{ type: "text", text: "" }],
    isError,
    structuredContentOmitted: true,
  };
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const attempt: Record<string, unknown> = {
      content: [{ type: "text", text: truncateMcpUtf8(fallbackContent, midpoint) }],
      isError,
      structuredContentOmitted: true,
    };
    const attemptJson = safeJson(attempt);
    if (
      attemptJson !== undefined &&
      Buffer.byteLength(attemptJson, "utf8") <= MCP_TOOL_RESULT_HARD_LIMIT_BYTES
    ) {
      boundedFallback = attempt;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return boundedFallback;
}

/**
 * Normalize an untrusted MCP CallToolResult into the runtime ToolResult shape.
 * Image blocks are validated and attached to the model-facing result. Other
 * binary blocks are persisted and replaced by references.
 */
export async function normalizeMcpToolOutput(
  options: NormalizeMcpToolOutputOptions,
): Promise<ToolResult> {
  const record = asRecord(options.raw);
  const isError = record?.isError === true;
  const state: RenderState = {
    budget: createMcpSanitizationBudget(MAX_MCP_BASE64_INSPECTION_BYTES),
    safeContentBlocks: [],
    textParts: [],
    binaryArtifacts: [],
    contentItems: [],
    displayAttachments: [],
    imageUrlBytes: 0,
    binaryBytes: 0,
    imagesProcessed: 0,
    base64InspectedBytes: 0,
    contentBlocksProcessed: 0,
    omitted: false,
  };
  const displayBudget = { remainingBytes: DISPLAY_WORK_LIMIT };

  if (record === null) {
    appendPrimitiveContent(state, options.raw);
  } else if (Array.isArray(record.content)) {
    const retainedBlocks = record.content.slice(
      0,
      MAX_MCP_TOOL_RESULT_CONTENT_BLOCKS,
    );
    for (const [index, block] of retainedBlocks.entries()) {
      state.contentBlocksProcessed += 1;
      const displayRecord = asRecord(block);
      const originalContent = asRecord(options.originalRaw)?.content;
      const originalDisplayRecord = asRecord(Array.isArray(originalContent) ? originalContent[index] : block);
      const annotations = asRecord(displayRecord?.annotations);
      if (Array.isArray(annotations?.audience) && annotations.audience.length === 1 && annotations.audience[0] === "user") {
        if (state.displayAttachments.length >= DISPLAY_ATTACHMENT_LIMIT) {
          appendStaticText(state, "[Display attachment could not be shown: limit of 8 attachments per result exceeded]");
          continue;
        }
        try {
          const safeDisplay = redactMcpAttachmentValue(displayRecord ?? {}, options.sensitiveHeaders, undefined, "content-block");
          // The bridge redacts before normalizing: a block whose bytes held a
          // saved secret arrives emptied and marked omitted. Never show it.
          if (options.sensitiveHeaders !== undefined &&
              (safeDisplay.omitted === true || asRecord(safeDisplay.resource)?.omitted === true)) {
            throw new DisplayValidationError("contained a saved secret");
          }
          const fileLink = originalDisplayRecord?.type === "resource_link" && displayRecord?.type === "resource_link";
          // A file is read from its original URI, but its title is built from
          // the redacted name: the validator truncates titles, and a secret cut
          // at that boundary could no longer be matched afterwards.
          const linkBlock = fileLink ? {
            ...originalDisplayRecord,
            ...("name" in safeDisplay ? { name: safeDisplay.name } : {}),
            ...("title" in safeDisplay ? { title: safeDisplay.title } : {}),
          } : safeDisplay;
          const shown = await validateDisplayBlock(linkBlock, options.displayRoots ?? [], undefined, options.displayDataRoot, displayBudget);
          if (displayContainsLiteralSecret(shown.attachment, options.sensitiveHeaders)) {
            releaseDisplayArtifactBytes(shown.attachment);
            throw new DisplayValidationError("contained a saved secret");
          }
          const attachment = fileLink
            ? withDisplayAttachmentTitle(shown.attachment, redactMcpAttachmentText(shown.attachment.title, options.sensitiveHeaders))
            : shown.attachment;
          const caption = fileLink ? redactMcpAttachmentText(shown.caption, options.sensitiveHeaders) : shown.caption;
          const imageBytes = state.displayAttachments.filter(item => item.kind === "image").reduce((sum, item) => sum + item.size, 0);
          if (attachment.kind === "image" && imageBytes + attachment.size > DISPLAY_BINARY_LIMIT) throw new DisplayValidationError("images exceed 5 MiB per result");
          const inlineBytes = [...state.displayAttachments, attachment].reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
          if (inlineBytes > MAX_DISPLAY_INLINE_COMPLETION_BYTES) throw new DisplayValidationError("display attachments exceed journal budget");
          state.displayAttachments.push(attachment);
          appendStaticText(state, caption);
        } catch (error) {
          const reason = error instanceof DisplayValidationError ? error.message : "file could not be read";
          appendStaticText(state, `[Display attachment could not be shown: ${reason}]`);
        }
        continue;
      }
      await renderContentBlock(state, block, index, options);
      if (
        state.budget.remainingBytes <= 0 ||
        state.budget.remainingNodes <= 0
      ) {
        if (index + 1 < retainedBlocks.length) state.omitted = true;
        break;
      }
    }
    if (record.content.length > retainedBlocks.length) state.omitted = true;
  } else if (record.content !== undefined) {
    appendPrimitiveContent(state, record.content);
  }

  const hasStructuredContent = record !== null &&
    Object.prototype.hasOwnProperty.call(record, "structuredContent");
  const structured = hasStructuredContent
    ? sanitizeStructuredValue(record.structuredContent, state.budget)
    : { omitted: false as const };
  if (structured.serialized !== undefined) {
    const structuredText = `Structured content:\n${structured.serialized}`;
    state.textParts.push(structuredText);
    state.contentItems.push({ type: "input_text", text: structuredText });
  } else if (hasStructuredContent) {
    state.omitted = true;
    appendStaticText(state, "[Oversized or invalid MCP structured content omitted]");
  }

  const hasMeta = record !== null &&
    Object.prototype.hasOwnProperty.call(record, "_meta");
  const meta = hasMeta
    ? sanitizeMetaValue(record._meta, state.budget)
    : { omitted: false as const };
  if (hasMeta && meta.omitted) state.omitted = true;

  if (state.omitted) appendStaticText(state, WORK_LIMIT_MARKER);
  if (state.textParts.length === 0) {
    appendStaticText(
      state,
      `(MCP tool ${sanitizeMcpOutputText(options.toolName)} completed with no output)`,
    );
  }

  const hardBound = hardBoundText(state.textParts.join("\n"));
  let content = hardBound.content;
  let persistedPath: string | undefined;
  let persistenceFailed = false;

  if (await mcpContentNeedsTruncation(content, options.environment)) {
    const persisted = await persistToolResult(content, options.callId);
    if (isPersistError(persisted)) {
      persistenceFailed = true;
      const truncated = await truncateMcpContentIfNeeded(
        content,
        options.environment,
      );
      content = typeof truncated === "string"
        ? truncated
        : "[MCP tool output exceeded the configured token limit and could not be persisted]";
    } else {
      persistedPath = persisted.filepath;
      content = buildLargeToolResultMessage(persisted);
    }
  }

  const structuredInline = structured.value !== undefined &&
    structured.serialized !== undefined &&
    !(await mcpContentNeedsTruncation(
      structured.serialized,
      options.environment,
    ));
  const metaSerialized = meta.value === undefined
    ? undefined
    : safeJson(meta.value);
  const metaInline = meta.value !== undefined &&
    metaSerialized !== undefined &&
    !(await mcpContentNeedsTruncation(metaSerialized, options.environment));
  const structuredContentInlineOmitted = structured.value !== undefined &&
    !structuredInline;
  const metaInlineOmitted = meta.value !== undefined && !metaInline;

  const codeModeCandidate: Record<string, unknown> = {
    content: persistedPath === undefined && !persistenceFailed
      ? state.safeContentBlocks
      : [{ type: "text", text: content }],
    isError,
    ...(structuredInline
      ? { structuredContent: structured.value }
      : {}),
    ...(metaInline
      ? { _meta: meta.value }
      : {}),
    ...(hasStructuredContent && (structured.omitted || structuredContentInlineOmitted)
      ? { structuredContentOmitted: true }
      : {}),
    ...(hasMeta && (meta.omitted || metaInlineOmitted)
      ? { metaOmitted: true }
      : {}),
    ...(persistedPath !== undefined
      ? { persistedOutput: { filepath: persistedPath } }
      : {}),
  };
  const codeModeResult = boundedCodeModeResult(
    codeModeCandidate,
    content,
    isError,
  );

  if (hardBound.truncated) {
    options.logger.warn?.(
      `MCP tool ${JSON.stringify(options.toolName)} result exceeded ${MCP_TOOL_RESULT_HARD_LIMIT_BYTES} bytes and was hard-bounded`,
    );
  }

  return {
    content,
    ...(state.imageUrlBytes > 0
      ? { contentItems: persistedPath === undefined && !persistenceFailed && !hardBound.truncated
          ? state.contentItems
          : [
              { type: "input_text" as const, text: content },
              ...state.contentItems.filter((item) => item.type === "input_image"),
            ] }
      : {}),
    isError,
    codeModeResult,
    metadata: {
      ...(state.displayAttachments.length > 0 ? { displayAttachments: state.displayAttachments } : {}),
      mcp: {
        server: options.serverName,
        tool: options.toolName,
        callId: options.callId,
        originalRenderedBytes: hardBound.originalBytes,
        hardLimitBytes: MCP_TOOL_RESULT_HARD_LIMIT_BYTES,
        hardTruncated: hardBound.truncated,
        workBudgetBytesRemaining: state.budget.remainingBytes,
        workBudgetNodesRemaining: state.budget.remainingNodes,
        contentBlocksAccepted: state.contentBlocksProcessed,
        structuredContentPresent: hasStructuredContent,
        structuredContentOmitted: structured.omitted,
        structuredContentInlineOmitted,
        metaPresent: hasMeta,
        metaOmitted: meta.omitted,
        metaInlineOmitted,
        base64InspectedBytes: state.base64InspectedBytes,
        binaryBytes: state.binaryBytes,
        binaryArtifacts: state.binaryArtifacts,
        ...(persistedPath !== undefined ? { persistedPath } : {}),
        ...(persistenceFailed ? { persistenceFailed: true } : {}),
      },
    },
  };
}
