/**
 * MCP resource bridge.
 *
 * The MCP spec distinguishes *tools* (callable actions) from
 * *resources* (readable content — files, blobs, logs). The existing
 * `tool-bridge.ts` covers tools only; this module adds read-only
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
        const response = await withDeadline<{
          resources?: Array<{
            uri: string;
            name?: string;
            description?: string;
            mimeType?: string;
          }>;
        }>(
          `MCP server "${serverName}" listResources`,
          rpcTimeoutMs,
          () => client.listResources({}),
        );
        const raw = Array.isArray(response.resources) ? response.resources : [];
        return raw.map((r) => ({
          serverName,
          uri: r.uri,
          namespacedName: `mcp.${serverName}.${r.uri}`,
          ...(r.name !== undefined ? { name: r.name } : {}),
          ...(r.description !== undefined ? { description: r.description } : {}),
          ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
        }));
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
      const response = await withDeadline<{
        contents?: Array<{
          uri: string;
          mimeType?: string;
          text?: string;
          blob?: string;
        }>;
      }>(
        `MCP server "${serverName}" readResource`,
        rpcTimeoutMs,
        () => client.readResource({ uri }),
      );
      const first = Array.isArray(response.contents)
        ? response.contents[0]
        : undefined;
      if (!first) {
        return {
          uri,
          truncated: false,
          bytesReturned: 0,
        };
      }

      if (typeof first.text === "string") {
        const bytes = Buffer.byteLength(first.text, "utf8");
        if (bytes > MAX_RESOURCE_BYTES) {
          const sliced = truncateUtf8(first.text, MAX_RESOURCE_BYTES);
          logger.warn?.(
            `MCP resource "${uri}" exceeded I-76 cap (${bytes}B > ${MAX_RESOURCE_BYTES}B); truncated`,
          );
          return {
            uri: first.uri,
            ...(first.mimeType !== undefined ? { mimeType: first.mimeType } : {}),
            text: sliced,
            truncated: true,
            bytesReturned: Buffer.byteLength(sliced, "utf8"),
          };
        }
        return {
          uri: first.uri,
          ...(first.mimeType !== undefined ? { mimeType: first.mimeType } : {}),
          text: first.text,
          truncated: false,
          bytesReturned: bytes,
        };
      }
      if (typeof first.blob === "string") {
        // Base64 — decode length approximately via 3/4 ratio.
        const blobBytes = Math.floor((first.blob.length * 3) / 4);
        if (blobBytes > MAX_RESOURCE_BYTES) {
          const maxBase64 = Math.floor((MAX_RESOURCE_BYTES * 4) / 3);
          const sliced = first.blob.slice(0, maxBase64);
          logger.warn?.(
            `MCP blob resource "${uri}" exceeded I-76 cap (~${blobBytes}B > ${MAX_RESOURCE_BYTES}B); truncated`,
          );
          return {
            uri: first.uri,
            ...(first.mimeType !== undefined ? { mimeType: first.mimeType } : {}),
            blob: sliced,
            truncated: true,
            bytesReturned: Math.floor((sliced.length * 3) / 4),
          };
        }
        return {
          uri: first.uri,
          ...(first.mimeType !== undefined ? { mimeType: first.mimeType } : {}),
          blob: first.blob,
          truncated: false,
          bytesReturned: blobBytes,
        };
      }

      return {
        uri: first.uri,
        ...(first.mimeType !== undefined ? { mimeType: first.mimeType } : {}),
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
