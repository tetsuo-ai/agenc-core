/**
 * Shared bounded cursor pagination for MCP list methods.
 *
 * The installed MCP SDK returns one page per `tools/list` / `prompts/list`
 * call. Callers must pass the previous `nextCursor` to retrieve the rest of
 * the catalog. This helper walks that cursor chain once, concatenates pages
 * in protocol order, and fail-closes on repeated cursors, page/item/byte
 * caps, timeout, or cancellation.
 *
 * One overall deadline covers every page and retry. Later pages receive the
 * remaining budget rather than a fresh unlimited timeout.
 *
 * @module
 */

import type { Logger } from "./_deps/logger.js";
import { asRecord } from "../utils/record.js";
import { isAbortError } from "../utils/errors.js";
import { sleep } from "../utils/sleep.js";
import { nonEmptyString } from "../utils/stringUtils.js";

/** Maximum cursor pages accepted from one MCP list operation. */
export const MAX_MCP_LIST_PAGES = 100;

/** Maximum raw catalog entries accepted across all cursor pages. */
export const MAX_MCP_LIST_ITEMS = 1_000;

/** Maximum UTF-8 bytes accepted for an opaque pagination cursor. */
export const MAX_MCP_LIST_CURSOR_BYTES = 8 * 1024;

/**
 * Maximum UTF-8 bytes of JSON-serialized catalog items accepted across
 * every page of one list operation (I-76).
 */
export const MAX_MCP_LIST_AGGREGATE_BYTES = 5 * 1024 * 1024;

export type McpListPaginationCode =
  | "repeated_cursor"
  | "oversized_cursor"
  | "page_limit"
  | "item_limit"
  | "aggregate_size"
  | "timeout";

export class McpListPaginationError extends Error {
  readonly code: McpListPaginationCode;

  constructor(message: string, code: McpListPaginationCode) {
    super(message);
    this.name = "McpListPaginationError";
    this.code = code;
  }
}

export interface McpListPageCallOptions {
  readonly signal: AbortSignal;
  readonly timeout: number;
}

export interface McpListRetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly logger: Logger;
  readonly operationName: string;
}

export interface CollectMcpListPagesOptions {
  readonly serverName: string;
  readonly method: string;
  readonly itemsKey: string;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly maxPages?: number;
  readonly maxItems?: number;
  readonly maxCursorBytes?: number;
  readonly maxAggregateBytes?: number;
  readonly retry?: McpListRetryOptions;
  readonly fetchPage: (
    cursor: string | undefined,
    options: McpListPageCallOptions,
  ) => Promise<unknown>;
}

interface PaginationMessageDetail {
  readonly maxPages?: number;
  readonly maxItems?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

/**
 * Follow `nextCursor` until the server stops, then return the concatenated
 * raw items in protocol order. Normalization, filtering, and hashing belong
 * to the caller after this returns.
 */
export async function collectMcpListPages(
  options: CollectMcpListPagesOptions,
): Promise<unknown[]> {
  const maxPages = requireBound(
    "maxPages",
    options.maxPages ?? MAX_MCP_LIST_PAGES,
    MAX_MCP_LIST_PAGES,
  );
  const maxItems = requireBound(
    "maxItems",
    options.maxItems ?? MAX_MCP_LIST_ITEMS,
    MAX_MCP_LIST_ITEMS,
  );
  const maxCursorBytes = requireBound(
    "maxCursorBytes",
    options.maxCursorBytes ?? MAX_MCP_LIST_CURSOR_BYTES,
    MAX_MCP_LIST_CURSOR_BYTES,
  );
  const maxAggregateBytes = requireBound(
    "maxAggregateBytes",
    options.maxAggregateBytes ?? MAX_MCP_LIST_AGGREGATE_BYTES,
    MAX_MCP_LIST_AGGREGATE_BYTES,
  );
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new RangeError("deadlineMs must be a positive finite number");
  }
  const maxAttempts = options.retry?.maxAttempts ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError("retry.maxAttempts must be a positive safe integer");
  }
  const baseDelayMs = options.retry?.baseDelayMs ?? 0;
  if (
    options.retry !== undefined &&
    (!Number.isFinite(baseDelayMs) || baseDelayMs < 0)
  ) {
    throw new RangeError("retry.baseDelayMs must be a finite number >= 0");
  }

  const deadlineMs = Math.floor(options.deadlineMs);
  const timeoutError = new McpListPaginationError(
    paginationMessage(options.serverName, options.method, "timeout", {
      timeoutMs: deadlineMs,
    }),
    "timeout",
  );

  options.signal?.throwIfAborted();

  const controller = new AbortController();
  let timedOut = false;
  const forwardCallerAbort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(options.signal?.reason);
    }
  };
  options.signal?.addEventListener("abort", forwardCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort(timeoutError);
  }, deadlineMs);
  const startedAt = Date.now();

  const remainingTimeout = (): number =>
    deadlineMs - (Date.now() - startedAt);

  const throwIfDeadlineExceeded = (): void => {
    options.signal?.throwIfAborted();
    if (timedOut || remainingTimeout() <= 0) throw timeoutError;
  };

  const fetchPageWithRetry = async (
    cursor: string | undefined,
  ): Promise<unknown> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfDeadlineExceeded();
      const remaining = remainingTimeout();
      try {
        const result = await options.fetchPage(cursor, {
          signal: controller.signal,
          timeout: Math.max(1, remaining),
        });
        throwIfDeadlineExceeded();
        return result;
      } catch (error) {
        throwIfDeadlineExceeded();
        if (error instanceof McpListPaginationError || isAbortError(error)) {
          throw error;
        }
        lastError = error;
        const retry = options.retry;
        if (attempt === maxAttempts || retry === undefined) break;
        retry.logger.warn(
          `MCP server ${JSON.stringify(options.serverName)} ${retry.operationName} attempt ${attempt} failed; retrying`,
        );
        throwIfDeadlineExceeded();
        const delay = Math.min(
          retry.baseDelayMs * attempt,
          Math.max(0, remainingTimeout()),
        );
        if (delay > 0) {
          await sleep(delay, controller.signal, {
            throwOnAbort: true,
            abortError: () => {
              if (options.signal?.aborted && options.signal.reason instanceof Error) {
                return options.signal.reason;
              }
              return timeoutError;
            },
          });
        }
      }
    }
    throw lastError;
  };

  try {
    const items: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let aggregateBytes = 0;

    for (let page = 0; page < maxPages; page += 1) {
      throwIfDeadlineExceeded();
      const response = await fetchPageWithRetry(cursor);
      throwIfDeadlineExceeded();

      const record = asRecord(response);
      const pageItems = arrayField(record, options.itemsKey);
      if (items.length + pageItems.length > maxItems) {
        throw new McpListPaginationError(
          paginationMessage(options.serverName, options.method, "item_limit", {
            maxItems,
          }),
          "item_limit",
        );
      }

      let pageBytes = 0;
      for (const item of pageItems) {
        try {
          pageBytes += jsonUtf8Bytes(item);
        } catch {
          throw new McpListPaginationError(
            paginationMessage(
              options.serverName,
              options.method,
              "aggregate_size",
              { maxBytes: maxAggregateBytes },
            ),
            "aggregate_size",
          );
        }
      }
      if (aggregateBytes + pageBytes > maxAggregateBytes) {
        throw new McpListPaginationError(
          paginationMessage(
            options.serverName,
            options.method,
            "aggregate_size",
            { maxBytes: maxAggregateBytes },
          ),
          "aggregate_size",
        );
      }

      items.push(...pageItems);
      aggregateBytes += pageBytes;

      const nextCursor = nonEmptyString(record?.nextCursor);
      if (nextCursor === undefined) {
        throwIfDeadlineExceeded();
        return items;
      }
      if (Buffer.byteLength(nextCursor, "utf8") > maxCursorBytes) {
        throw new McpListPaginationError(
          paginationMessage(
            options.serverName,
            options.method,
            "oversized_cursor",
            { maxBytes: maxCursorBytes },
          ),
          "oversized_cursor",
        );
      }
      if (seenCursors.has(nextCursor)) {
        throw new McpListPaginationError(
          paginationMessage(
            options.serverName,
            options.method,
            "repeated_cursor",
          ),
          "repeated_cursor",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new McpListPaginationError(
      paginationMessage(options.serverName, options.method, "page_limit", {
        maxPages,
      }),
      "page_limit",
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardCallerAbort);
  }
}

function requireBound(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new RangeError(
      `${name} must be a safe integer between 1 and ${max}`,
    );
  }
  return value;
}

function arrayField(
  record: Record<string, unknown> | null,
  key: string,
): readonly unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function jsonUtf8Bytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded ?? "null", "utf8");
}

function paginationMessage(
  serverName: string,
  method: string,
  code: McpListPaginationCode,
  detail: PaginationMessageDetail = {},
): string {
  const messages = {
    repeated_cursor: () =>
      `MCP server "${serverName}" repeated a ${method} cursor`,
    oversized_cursor: () =>
      `MCP server "${serverName}" ${method} cursor exceeded ${detail.maxBytes} UTF-8 bytes`,
    page_limit: () =>
      `MCP server "${serverName}" ${method} exceeded ${detail.maxPages} pages`,
    item_limit: () =>
      `MCP server "${serverName}" ${method} exceeded ${detail.maxItems} catalog entries`,
    aggregate_size: () =>
      `MCP server "${serverName}" ${method} exceeded ${detail.maxBytes} aggregate catalog bytes`,
    timeout: () =>
      `MCP server "${serverName}" ${method} timed out after ${detail.timeoutMs}ms`,
  } satisfies Record<McpListPaginationCode, () => string>;
  return messages[code]();
}
