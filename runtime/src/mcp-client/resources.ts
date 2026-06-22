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
 *   - I-76: total bytes returned per resource capped at 5MB
 *     (`MAX_RESOURCE_BYTES`). Overages truncate with a marker +
 *     emit a warning via the provided logger.
 *
 * @module
 */

import type { Logger } from "./_deps/logger.js";
import { silentLogger } from "./_deps/logger.js";
import { asRecord } from "../utils/record.js";
import { nonEmptyString } from "../utils/stringUtils.js";

/** Upper bound on a single resource read (I-76). */
export const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;

/** Default upstream RPC timeout for resource ops (ms). */
const DEFAULT_RESOURCE_RPC_TIMEOUT_MS = 30_000;

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

export interface MCPResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  /** Decoded text (if the resource is text). */
  readonly text?: string;
  /** Base64 blob (if the resource is binary). */
  readonly blob?: string;
  /** True when I-76 cap truncated the payload. */
  readonly truncated: boolean;
  readonly bytesReturned: number;
}

export interface MCPResourceBridge {
  readonly serverName: string;
  listResources(): Promise<ReadonlyArray<MCPResourceDescriptor>>;
  readResource(uri: string): Promise<MCPResourceContent>;
  dispose(): Promise<void>;
}

interface CreateResourceBridgeOpts {
  readonly rpcTimeoutMs?: number;
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
  let disposed = false;

  return {
    serverName,
    async listResources(): Promise<ReadonlyArray<MCPResourceDescriptor>> {
      if (disposed) return [];
      try {
        const response = await withDeadline<unknown>(
          `MCP server "${serverName}" listResources`,
          rpcTimeoutMs,
          () => client.listResources({}),
        );
        return normalizeResourceCatalog(response, serverName);
      } catch (err) {
        logger.warn?.(
          `MCP server "${serverName}" listResources failed:`,
          err,
        );
        return [];
      }
    },
    async readResource(uri: string): Promise<MCPResourceContent> {
      if (disposed) {
        throw new Error(
          `MCP resource bridge for "${serverName}" has been disposed`,
        );
      }
      const response = await withDeadline<unknown>(
        `MCP server "${serverName}" readResource`,
        rpcTimeoutMs,
        () => client.readResource({ uri }),
      );
      const first = firstResourceContent(response);
      if (!first) {
        return {
          uri,
          truncated: false,
          bytesReturned: 0,
        };
      }

      const contentUri = stringField(first, "uri") ?? uri;
      const mimeType = stringField(first, "mimeType");
      const text = stringField(first, "text");
      const blob = stringField(first, "blob");

      if (text !== undefined) {
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > MAX_RESOURCE_BYTES) {
          const sliced = truncateUtf8(text, MAX_RESOURCE_BYTES);
          logger.warn?.(
            `MCP resource "${uri}" exceeded I-76 cap (${bytes}B > ${MAX_RESOURCE_BYTES}B); truncated`,
          );
          return {
            uri: contentUri,
            ...(mimeType !== undefined ? { mimeType } : {}),
            text: sliced,
            truncated: true,
            bytesReturned: Buffer.byteLength(sliced, "utf8"),
          };
        }
        return {
          uri: contentUri,
          ...(mimeType !== undefined ? { mimeType } : {}),
          text,
          truncated: false,
          bytesReturned: bytes,
        };
      }
      if (blob !== undefined) {
        // Base64 — decode length approximately via 3/4 ratio.
        const blobBytes = Math.floor((blob.length * 3) / 4);
        if (blobBytes > MAX_RESOURCE_BYTES) {
          const maxBase64 = Math.floor((MAX_RESOURCE_BYTES * 4) / 3);
          const sliced = blob.slice(0, maxBase64);
          logger.warn?.(
            `MCP blob resource "${uri}" exceeded I-76 cap (~${blobBytes}B > ${MAX_RESOURCE_BYTES}B); truncated`,
          );
          return {
            uri: contentUri,
            ...(mimeType !== undefined ? { mimeType } : {}),
            blob: sliced,
            truncated: true,
            bytesReturned: Math.floor((sliced.length * 3) / 4),
          };
        }
        return {
          uri: contentUri,
          ...(mimeType !== undefined ? { mimeType } : {}),
          blob,
          truncated: false,
          bytesReturned: blobBytes,
        };
      }

      return {
        uri: contentUri,
        ...(mimeType !== undefined ? { mimeType } : {}),
        truncated: false,
        bytesReturned: 0,
      };
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
): MCPResourceDescriptor[] {
  return arrayField(asRecord(response), "resources")
    .map((raw) => normalizeResourceDescriptor(raw, serverName))
    .filter((resource): resource is MCPResourceDescriptor => resource !== null);
}

function normalizeResourceDescriptor(
  raw: unknown,
  serverName: string,
): MCPResourceDescriptor | null {
  const record = asRecord(raw);
  if (!record) return null;

  const uri = nonEmptyString(record.uri);
  if (!uri) return null;

  const name = stringField(record, "name");
  const description = stringField(record, "description");
  const mimeType = stringField(record, "mimeType");

  return {
    serverName,
    uri,
    namespacedName: `mcp.${serverName}.${uri}`,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
  };
}

function firstResourceContent(response: unknown): Record<string, unknown> | undefined {
  return arrayField(asRecord(response), "contents")
    .map(asRecord)
    .find((record): record is Record<string, unknown> => record !== null);
}

function withDeadline<T>(
  operation: string,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([task(), timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Truncate a string so its UTF-8 byte length is <= `maxBytes`.
 * Avoids splitting multi-byte codepoints mid-sequence.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  // Walk back from the cut to a codepoint boundary.
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}
