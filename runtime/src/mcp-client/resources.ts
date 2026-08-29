/**
 * MCP resource bridge.
 *
 * The MCP spec distinguishes *tools* (callable actions) from
 * *resources* (readable content — files, blobs, logs). The existing
 * `tools.ts` covers tools only; this module adds read-only
 * access to MCP resources so AgenC callers can list + fetch them.
 *
 * Resource URIs are namespaced as `mcp.<serverName>.<origUri>` when
 * surfaced up to the runtime, but the bridge also exposes the raw
 * upstream `uri` so callers can correlate with server-side logs.
 *
 * Supply-chain:
 *   - I-76: total decoded bytes returned per resource read are capped at
 *     5 MiB (`MAX_RESOURCE_BYTES`), with a 1 MiB per-content-block cap.
 *     Truncation remains explicit on both the block and aggregate result.
 *   - Resource catalogs follow cursor pagination, bounded by
 *     `MAX_RESOURCE_LIST_PAGES`, and reject repeated cursors.
 *
 * @module
 */

import type { Logger } from "./_deps/logger.js";
import { silentLogger } from "./_deps/logger.js";
import { sanitizeSystemReminderContent } from "../prompts/attachments/system-reminder-sanitizer.js";
import { asRecord } from "../utils/record.js";
import { recursivelySanitizeUnicode } from "../utils/sanitization.js";
import { nonEmptyString } from "../utils/stringUtils.js";

/** Aggregate decoded-payload upper bound for one resource read (I-76). */
export const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;

/** Decoded-payload upper bound for one resource content block. */
export const MAX_RESOURCE_ENTRY_BYTES = 1 * 1024 * 1024;

/** Maximum cursor pages accepted from one resources/list operation. */
export const MAX_RESOURCE_LIST_PAGES = 100;

/** Maximum raw catalog entries accepted across all cursor pages. */
export const MAX_RESOURCE_DESCRIPTORS = 1_000;

/** Maximum raw content blocks normalized from one resources/read result. */
export const MAX_RESOURCE_CONTENT_BLOCKS = 256;

/** Maximum UTF-8 bytes for an opaque resource URI identity. */
export const MAX_RESOURCE_URI_BYTES = 8 * 1024;

/** Maximum UTF-8 bytes for sanitized resource display names. */
export const MAX_RESOURCE_NAME_BYTES = 1 * 1024;

/** Maximum UTF-8 bytes for sanitized resource descriptions. */
export const MAX_RESOURCE_DESCRIPTION_BYTES = 8 * 1024;

/** Maximum UTF-8 bytes for sanitized resource MIME metadata. */
export const MAX_RESOURCE_MIME_TYPE_BYTES = 256;

/** Maximum UTF-8 bytes accepted for an opaque pagination cursor. */
export const MAX_RESOURCE_CURSOR_BYTES = 8 * 1024;

/**
 * Maximum encoded blob characters accepted from one block and inspected
 * across one resource read before failing closed.
 */
export const MAX_RESOURCE_BLOB_INPUT_CHARS =
  4 * Math.ceil(MAX_RESOURCE_BYTES / 3);

/** Default upstream RPC timeout for resource ops (ms). */
const DEFAULT_RESOURCE_RPC_TIMEOUT_MS = 30_000;

const RESOURCE_METADATA_TRUNCATION_MARKER = "... (truncated)";

export interface MCPResourceDescriptor {
  readonly serverName: string;
  /** Raw upstream URI (`file:///...`, `resource:...`, etc). */
  readonly uri: string;
  /** Namespaced name for the runtime side: `mcp.<server>.<uri>`. */
  readonly namespacedName: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

interface MCPResourceContentBlockBase {
  readonly uri: string;
  readonly mimeType?: string;
  /** True when the per-entry or aggregate cap truncated this block. */
  readonly truncated: boolean;
  /** UTF-8 text bytes or decoded blob bytes retained for this block. */
  readonly bytesReturned: number;
}

export interface MCPResourceTextContent extends MCPResourceContentBlockBase {
  /** Sanitized, well-formed Unicode text. */
  readonly text: string;
  readonly blob?: never;
}

export interface MCPResourceBlobContent extends MCPResourceContentBlockBase {
  /** Canonical base64 containing only the retained decoded bytes. */
  readonly blob: string;
  readonly text?: never;
}

export type MCPResourceContentBlock =
  MCPResourceTextContent | MCPResourceBlobContent;

export interface MCPResourceContent {
  /** Every valid upstream content block within the explicit count bound. */
  readonly contents: ReadonlyArray<MCPResourceContentBlock>;
  /** True when a block-count, per-entry, or aggregate byte cap was hit. */
  readonly truncated: boolean;
  /** Aggregate UTF-8 text bytes plus decoded blob bytes retained. */
  readonly bytesReturned: number;
}

export interface MCPResourceBridge {
  readonly serverName: string;
  listResources(
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<MCPResourceDescriptor>>;
  readResource(uri: string, signal?: AbortSignal): Promise<MCPResourceContent>;
  dispose(): Promise<void>;
}

interface CreateResourceBridgeOpts {
  readonly rpcTimeoutMs?: number;
  /** Test seam; production remains bounded by `MAX_RESOURCE_LIST_PAGES`. */
  readonly maxListPages?: number;
}

/**
 * Build a resource bridge around an already-connected MCP client.
 * Gracefully degrades: if the server does not expose
 * `resources.list` / `resources.read`, the returned bridge resolves
 * to an empty list + throws on read.
 */
export async function createResourceBridge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  serverName: string,
  logger: Logger = silentLogger,
  opts: CreateResourceBridgeOpts = {},
): Promise<MCPResourceBridge> {
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? DEFAULT_RESOURCE_RPC_TIMEOUT_MS;
  const maxListPages = opts.maxListPages ?? MAX_RESOURCE_LIST_PAGES;
  if (
    !Number.isSafeInteger(maxListPages) ||
    maxListPages <= 0 ||
    maxListPages > MAX_RESOURCE_LIST_PAGES
  ) {
    throw new RangeError(
      `maxListPages must be a safe integer between 1 and ${MAX_RESOURCE_LIST_PAGES}`,
    );
  }
  let disposed = false;

  return {
    serverName,
    async listResources(
      signal?: AbortSignal,
    ): Promise<ReadonlyArray<MCPResourceDescriptor>> {
      if (disposed) return [];
      try {
        const resources: MCPResourceDescriptor[] = [];
        const seenCursors = new Set<string>();
        let catalogEntries = 0;
        let cursor: string | undefined;

        for (let page = 0; page < maxListPages; page += 1) {
          signal?.throwIfAborted();
          const response = await withDeadline<unknown>(
            `MCP server "${serverName}" listResources`,
            rpcTimeoutMs,
            (effectSignal) =>
              client.listResources(cursor === undefined ? {} : { cursor }, {
                signal: effectSignal,
                timeout: rpcTimeoutMs,
              }),
            signal,
          );
          const responseRecord = asRecord(response);
          resources.push(
            ...normalizeResourceCatalog(
              responseRecord,
              serverName,
              MAX_RESOURCE_DESCRIPTORS - catalogEntries,
              logger,
            ),
          );
          catalogEntries += arrayField(responseRecord, "resources").length;

          const nextCursor = nonEmptyString(responseRecord?.nextCursor);
          if (nextCursor === undefined) return resources;
          if (!fitsUtf8(nextCursor, MAX_RESOURCE_CURSOR_BYTES)) {
            throw new Error(
              `MCP server "${serverName}" resources/list cursor exceeded ${MAX_RESOURCE_CURSOR_BYTES} UTF-8 bytes`,
            );
          }
          if (seenCursors.has(nextCursor)) {
            throw new Error(
              `MCP server "${serverName}" repeated a resources/list cursor`,
            );
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }

        throw new Error(
          `MCP server "${serverName}" resources/list exceeded ${maxListPages} pages`,
        );
      } catch (err) {
        signal?.throwIfAborted();
        logger.warn?.(`MCP server "${serverName}" listResources failed:`, err);
        return [];
      }
    },
    async readResource(
      uri: string,
      signal?: AbortSignal,
    ): Promise<MCPResourceContent> {
      if (disposed) {
        throw new Error(
          `MCP resource bridge for "${serverName}" has been disposed`,
        );
      }
      if (!fitsUtf8(uri, MAX_RESOURCE_URI_BYTES)) {
        throw new RangeError(
          `MCP resource URI exceeds ${MAX_RESOURCE_URI_BYTES} UTF-8 bytes`,
        );
      }
      const response = await withDeadline<unknown>(
        `MCP server "${serverName}" readResource`,
        rpcTimeoutMs,
        (effectSignal) =>
          client.readResource(
            { uri },
            { signal: effectSignal, timeout: rpcTimeoutMs },
          ),
        signal,
      );
      return normalizeResourceContents(response, uri, logger);
    },
    async dispose(): Promise<void> {
      disposed = true;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function arrayField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): readonly unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function normalizeResourceCatalog(
  response: unknown,
  serverName: string,
  remainingEntries: number,
  logger: Logger,
): MCPResourceDescriptor[] {
  const rawResources = arrayField(asRecord(response), "resources");
  if (rawResources.length > remainingEntries) {
    throw new Error(
      `MCP server "${serverName}" resources/list exceeded ${MAX_RESOURCE_DESCRIPTORS} catalog entries`,
    );
  }
  return rawResources
    .map((raw, index) =>
      normalizeResourceDescriptor(raw, serverName, index, logger),
    )
    .filter((resource): resource is MCPResourceDescriptor => resource !== null);
}

function normalizeResourceDescriptor(
  raw: unknown,
  serverName: string,
  index: number,
  logger: Logger,
): MCPResourceDescriptor | null {
  const record = asRecord(raw);
  if (!record) return null;

  const uri = nonEmptyString(record.uri);
  if (!uri) return null;
  if (!fitsUtf8(uri, MAX_RESOURCE_URI_BYTES)) {
    logger.warn?.(
      `MCP server "${serverName}" resource descriptor ${index} URI exceeded ${MAX_RESOURCE_URI_BYTES} UTF-8 bytes; ignored`,
    );
    return null;
  }

  const name = sanitizeOptionalBoundedResourceText(
    stringField(record, "name"),
    MAX_RESOURCE_NAME_BYTES,
  );
  const description = sanitizeOptionalBoundedResourceText(
    stringField(record, "description"),
    MAX_RESOURCE_DESCRIPTION_BYTES,
  );
  const mimeType = sanitizeOptionalBoundedResourceText(
    stringField(record, "mimeType"),
    MAX_RESOURCE_MIME_TYPE_BYTES,
  );

  return {
    serverName,
    uri,
    namespacedName: `mcp.${serverName}.${uri}`,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
  };
}

function normalizeResourceContents(
  response: unknown,
  requestedUri: string,
  logger: Logger,
): MCPResourceContent {
  const rawContents = arrayField(asRecord(response), "contents");
  const blockLimitTruncated = rawContents.length > MAX_RESOURCE_CONTENT_BLOCKS;
  if (blockLimitTruncated) {
    logger.warn?.(
      `MCP resource read returned ${rawContents.length} content blocks; only the first ${MAX_RESOURCE_CONTENT_BLOCKS} were retained`,
    );
  }
  const contents: MCPResourceContentBlock[] = [];
  let bytesReturned = 0;
  let remainingBytes = MAX_RESOURCE_BYTES;
  let remainingBlobInspectionChars = MAX_RESOURCE_BLOB_INPUT_CHARS;

  for (
    let index = 0;
    index < Math.min(rawContents.length, MAX_RESOURCE_CONTENT_BLOCKS);
    index += 1
  ) {
    const raw = rawContents[index];
    const record = asRecord(raw);
    if (!record) continue;

    const text = stringField(record, "text");
    const blob = stringField(record, "blob");
    if ((text === undefined) === (blob === undefined)) {
      logger.warn?.(
        `MCP resource content block ${index} must contain exactly one of text or blob; ignored`,
      );
      continue;
    }

    const rawUri = stringField(record, "uri") ?? requestedUri;
    if (!fitsUtf8(rawUri, MAX_RESOURCE_URI_BYTES)) {
      logger.warn?.(
        `MCP resource content block ${index} URI exceeded ${MAX_RESOURCE_URI_BYTES} UTF-8 bytes; ignored`,
      );
      continue;
    }
    const uri = sanitizeResourceText(rawUri);
    if (!fitsUtf8(uri, MAX_RESOURCE_URI_BYTES)) {
      logger.warn?.(
        `MCP resource content block ${index} sanitized URI exceeded ${MAX_RESOURCE_URI_BYTES} UTF-8 bytes; ignored`,
      );
      continue;
    }
    const mimeType = sanitizeOptionalBoundedResourceText(
      stringField(record, "mimeType"),
      MAX_RESOURCE_MIME_TYPE_BYTES,
    );
    const entryBudget = Math.min(MAX_RESOURCE_ENTRY_BYTES, remainingBytes);

    if (text !== undefined) {
      const rawPrefix = truncateUtf8(text, entryBudget);
      const rawTruncated = rawPrefix.length < text.length;
      const sanitized = sanitizeResourceText(rawPrefix);
      const retained = truncateUtf8(sanitized, entryBudget);
      const retainedBytes = Buffer.byteLength(retained, "utf8");
      const truncated = rawTruncated || retained.length < sanitized.length;
      contents.push({
        uri,
        ...(mimeType !== undefined ? { mimeType } : {}),
        text: retained,
        truncated,
        bytesReturned: retainedBytes,
      });
      bytesReturned += retainedBytes;
      remainingBytes -= retainedBytes;
      if (truncated) {
        logger.warn?.(
          `MCP text resource content block ${index} for "${safeLogLabel(rawUri)}" exceeded its bounded byte budget; truncated`,
        );
      }
      continue;
    }

    const blobValue = blob as string;
    if (blobValue.length > MAX_RESOURCE_BLOB_INPUT_CHARS) {
      contents.push({
        uri,
        ...(mimeType !== undefined ? { mimeType } : {}),
        blob: "",
        truncated: true,
        bytesReturned: 0,
      });
      logger.warn?.(
        `MCP blob resource content block ${index} for "${safeLogLabel(rawUri)}" exceeded ${MAX_RESOURCE_BLOB_INPUT_CHARS} encoded characters; content omitted`,
      );
      continue;
    }

    if (entryBudget === 0) {
      contents.push({
        uri,
        ...(mimeType !== undefined ? { mimeType } : {}),
        blob: "",
        truncated: blobValue.length > 0,
        bytesReturned: 0,
      });
      continue;
    }

    const prefixChars = encodedCharsForDecodedBytes(entryBudget);
    const inspectionChars = Math.min(blobValue.length, prefixChars);
    if (inspectionChars > remainingBlobInspectionChars) {
      remainingBlobInspectionChars = 0;
      contents.push({
        uri,
        ...(mimeType !== undefined ? { mimeType } : {}),
        blob: "",
        truncated: blobValue.length > 0,
        bytesReturned: 0,
      });
      logger.warn?.(
        `MCP blob resource content block ${index} for "${safeLogLabel(rawUri)}" exceeded the aggregate encoded-input inspection budget; content omitted`,
      );
      continue;
    }
    remainingBlobInspectionChars -= inspectionChars;

    if (blobValue.length > inspectionChars) {
      const prefix = blobValue.slice(0, inspectionChars);
      if (!BASE64_UNPADDED_PREFIX_PATTERN.test(prefix)) {
        logger.warn?.(
          `MCP blob resource content block ${index} for "${safeLogLabel(rawUri)}" did not have a valid base64 prefix; ignored`,
        );
        continue;
      }
      const retainedBuffer = Buffer.from(prefix, "base64").subarray(
        0,
        entryBudget,
      );
      contents.push({
        uri,
        ...(mimeType !== undefined ? { mimeType } : {}),
        blob: retainedBuffer.toString("base64"),
        truncated: true,
        bytesReturned: retainedBuffer.length,
      });
      bytesReturned += retainedBuffer.length;
      remainingBytes -= retainedBuffer.length;
      logger.warn?.(
        `MCP blob resource content block ${index} for "${safeLogLabel(rawUri)}" exceeded its bounded byte budget; truncated`,
      );
      continue;
    }

    const inspected = inspectBase64(blobValue);
    if (inspected === null) {
      logger.warn?.(
        `MCP blob resource content block ${index} for "${safeLogLabel(rawUri)}" was not valid canonical base64; ignored`,
      );
      continue;
    }
    const retainedBytes = Math.min(inspected.decodedBytes, entryBudget);
    const retainedBlob = decodeBase64Prefix(
      inspected.unpadded,
      retainedBytes,
    ).toString("base64");
    const truncated = retainedBytes < inspected.decodedBytes;
    contents.push({
      uri,
      ...(mimeType !== undefined ? { mimeType } : {}),
      blob: retainedBlob,
      truncated,
      bytesReturned: retainedBytes,
    });
    bytesReturned += retainedBytes;
    remainingBytes -= retainedBytes;
    if (truncated) {
      logger.warn?.(
        `MCP blob resource content block ${index} for "${safeLogLabel(rawUri)}" exceeded its bounded byte budget; truncated`,
      );
    }
  }

  return {
    contents,
    truncated:
      blockLimitTruncated || contents.some((content) => content.truncated),
    bytesReturned,
  };
}

function sanitizeOptionalBoundedResourceText(
  value: string | undefined,
  maxBytes: number,
): string | undefined {
  return value === undefined
    ? undefined
    : sanitizeBoundedResourceText(value, maxBytes);
}

function sanitizeBoundedResourceText(value: string, maxBytes: number): string {
  const rawPrefix = truncateUtf8(value, maxBytes);
  const rawTruncated = rawPrefix.length < value.length;
  const sanitized = sanitizeResourceText(rawPrefix);
  if (!rawTruncated && fitsUtf8(sanitized, maxBytes)) return sanitized;

  const markerBytes = Buffer.byteLength(
    RESOURCE_METADATA_TRUNCATION_MARKER,
    "utf8",
  );
  const prefixBudget = Math.max(0, maxBytes - markerBytes);
  return `${truncateUtf8(sanitized, prefixBudget)}${RESOURCE_METADATA_TRUNCATION_MARKER}`;
}

function sanitizeResourceText(value: string): string {
  const wellFormed = repairUnpairedSurrogates(value);
  return sanitizeSystemReminderContent(recursivelySanitizeUnicode(wellFormed));
}

function repairUnpairedSurrogates(value: string): string {
  let parts: string[] | undefined;
  let segmentStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      continue;
    }

    parts ??= [];
    parts.push(value.slice(segmentStart, index), "\ufffd");
    segmentStart = index + 1;
  }

  if (parts === undefined) return value;
  parts.push(value.slice(segmentStart));
  return parts.join("");
}

function safeLogLabel(value: string): string {
  const sanitized = sanitizeResourceText(value).replace(/\s+/gu, " ").trim();
  return Array.from(sanitized).slice(0, 256).join("");
}

interface InspectedBase64 {
  readonly decodedBytes: number;
  readonly unpadded: string;
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_TEXT_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const BASE64_UNPADDED_PREFIX_PATTERN = /^[A-Za-z0-9+/]*$/u;

function encodedCharsForDecodedBytes(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** Validate standard padded or unpadded base64 without decoding it unbounded. */
function inspectBase64(value: string): InspectedBase64 | null {
  const match = BASE64_TEXT_PATTERN.exec(value);
  if (match === null || match[0].length !== value.length) return null;

  const unpadded = value.replace(/=+$/u, "");
  const padding = value.length - unpadded.length;
  const remainder = unpadded.length % 4;
  if (remainder === 1) return null;
  if (padding > 0 && (value.length % 4 !== 0 || padding !== 4 - remainder)) {
    return null;
  }

  // Reject non-canonical unused bits. This prevents two different strings
  // from representing the same retained binary value.
  if (remainder === 2) {
    const last = BASE64_ALPHABET.indexOf(unpadded.at(-1) ?? "");
    if (last < 0 || (last & 0x0f) !== 0) return null;
  } else if (remainder === 3) {
    const last = BASE64_ALPHABET.indexOf(unpadded.at(-1) ?? "");
    if (last < 0 || (last & 0x03) !== 0) return null;
  }

  return {
    decodedBytes: Math.floor((unpadded.length * 6) / 8),
    unpadded,
  };
}

function decodeBase64Prefix(unpadded: string, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const encodedChars = Math.ceil(maxBytes / 3) * 4;
  return Buffer.from(unpadded.slice(0, encodedChars), "base64").subarray(
    0,
    maxBytes,
  );
}

async function withDeadline<T>(
  operation: string,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  callerSignal?.throwIfAborted();

  const controller = new AbortController();
  const timeoutError = new Error(`${operation} timed out after ${timeoutMs}ms`);
  let timedOut = false;
  const forwardCallerAbort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(callerSignal?.reason);
    }
  };
  callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort(timeoutError);
  }, timeoutMs);

  try {
    // Do not race away from the raw RPC. The deadline actively aborts its
    // signal, but this promise remains pending until the transport confirms
    // settlement. That keeps the enclosing admission lease's physical
    // concurrency slot occupied even if an MCP client ignores cancellation.
    const result = await task(controller.signal);
    callerSignal?.throwIfAborted();
    if (timedOut) throw timeoutError;
    return result;
  } catch (error) {
    callerSignal?.throwIfAborted();
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forwardCallerAbort);
  }
}

/**
 * Truncate a string so its UTF-8 byte length is <= `maxBytes`.
 * Avoids splitting multi-byte codepoints mid-sequence.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  return text.slice(0, utf8PrefixEnd(text, maxBytes));
}

function fitsUtf8(text: string, maxBytes: number): boolean {
  return utf8PrefixEnd(text, maxBytes) === text.length;
}

function utf8PrefixEnd(text: string, maxBytes: number): number {
  if (maxBytes <= 0) return 0;

  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    const characterBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return end;
}
