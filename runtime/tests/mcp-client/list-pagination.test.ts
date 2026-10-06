import { describe, expect, it, vi } from "vitest";
import {
  collectMcpListPages,
  MAX_MCP_LIST_AGGREGATE_BYTES,
  MAX_MCP_LIST_CURSOR_BYTES,
  MAX_MCP_LIST_ITEMS,
  MAX_MCP_LIST_PAGES,
  McpListPaginationError,
  type McpListPageCallOptions,
} from "./list-pagination.js";
import { AbortError } from "../../src/utils/errors.js";
import type { Logger } from "./_deps/logger.js";

function testLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function collect(options: {
  fetchPage: (
    cursor: string | undefined,
    callOptions: McpListPageCallOptions,
  ) => Promise<unknown>;
  deadlineMs?: number;
  signal?: AbortSignal;
  maxPages?: number;
  maxItems?: number;
  maxCursorBytes?: number;
  maxAggregateBytes?: number;
  retry?: {
    maxAttempts: number;
    baseDelayMs: number;
    logger?: Logger;
    operationName?: string;
  };
}) {
  const logger = options.retry?.logger ?? testLogger();
  return collectMcpListPages({
    serverName: "srv",
    method: "tools/list",
    itemsKey: "tools",
    deadlineMs: options.deadlineMs ?? 5_000,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
    ...(options.maxCursorBytes !== undefined
      ? { maxCursorBytes: options.maxCursorBytes }
      : {}),
    ...(options.maxAggregateBytes !== undefined
      ? { maxAggregateBytes: options.maxAggregateBytes }
      : {}),
    ...(options.retry !== undefined
      ? {
          retry: {
            maxAttempts: options.retry.maxAttempts,
            baseDelayMs: options.retry.baseDelayMs,
            logger,
            operationName: options.retry.operationName ?? "listTools",
          },
        }
      : {}),
    fetchPage: options.fetchPage,
  });
}

describe("collectMcpListPages", () => {
  it("returns a single page when the server omits nextCursor", async () => {
    const fetchPage = vi.fn(async () => ({
      tools: [{ name: "only" }],
    }));

    await expect(collect({ fetchPage })).resolves.toEqual([{ name: "only" }]);
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(fetchPage).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeout: expect.any(Number),
      }),
    );
  });

  it("concatenates two pages in protocol order and forwards the exact cursor", async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) => {
      if (cursor === undefined) {
        return { tools: [{ name: "a" }], nextCursor: "page-2" };
      }
      expect(cursor).toBe("page-2");
      return { tools: [{ name: "b" }] };
    });

    await expect(collect({ fetchPage })).resolves.toEqual([
      { name: "a" },
      { name: "b" },
    ]);
    expect(fetchPage).toHaveBeenNthCalledWith(
      1,
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchPage).toHaveBeenNthCalledWith(
      2,
      "page-2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("walks a multi-page catalog and keeps later cursors exact", async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) => {
      if (cursor === undefined) {
        return { tools: [{ name: "a" }], nextCursor: "c2" };
      }
      if (cursor === "c2") {
        return { tools: [{ name: "b" }], nextCursor: "c3" };
      }
      expect(cursor).toBe("c3");
      return { tools: [{ name: "c" }] };
    });

    await expect(collect({ fetchPage })).resolves.toEqual([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ]);
    expect(fetchPage.mock.calls.map((call) => call[0])).toEqual([
      undefined,
      "c2",
      "c3",
    ]);
  });

  it("treats a missing, blank, or non-string nextCursor as the end of the list", async () => {
    for (const nextCursor of [undefined, "", "   ", null, 12]) {
      const fetchPage = vi.fn(async () => ({
        tools: [{ name: "done" }],
        nextCursor,
      }));
      await expect(collect({ fetchPage })).resolves.toEqual([{ name: "done" }]);
      expect(fetchPage).toHaveBeenCalledOnce();
    }
  });

  it("treats a non-record response or non-array items as an empty page", async () => {
    await expect(
      collect({ fetchPage: async () => ["not-a-record"] }),
    ).resolves.toEqual([]);
    await expect(
      collect({ fetchPage: async () => ({ tools: { name: "nope" } }) }),
    ).resolves.toEqual([]);
  });

  it("fails closed on a repeated cursor", async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) => ({
      tools: [{ name: cursor ?? "first" }],
      nextCursor: "again",
    }));

    await expect(collect({ fetchPage })).rejects.toMatchObject({
      name: "McpListPaginationError",
      code: "repeated_cursor",
      message: 'MCP server "srv" repeated a tools/list cursor',
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("fails closed on an oversized cursor", async () => {
    const fetchPage = vi.fn(async () => ({
      tools: [{ name: "a" }],
      nextCursor: "c".repeat(MAX_MCP_LIST_CURSOR_BYTES + 1),
    }));

    await expect(collect({ fetchPage })).rejects.toMatchObject({
      code: "oversized_cursor",
      message: expect.stringContaining(
        `cursor exceeded ${MAX_MCP_LIST_CURSOR_BYTES} UTF-8 bytes`,
      ),
    });
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("fails closed when the page bound is exceeded", async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) => ({
      tools: [{ name: cursor ?? "p1" }],
      nextCursor: cursor === undefined ? "p2" : "p3",
    }));

    await expect(collect({ fetchPage, maxPages: 2 })).rejects.toMatchObject({
      code: "page_limit",
      message: 'MCP server "srv" tools/list exceeded 2 pages',
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a single page exceeds the item bound", async () => {
    const fetchPage = vi.fn(async () => ({
      tools: [{ name: "a" }, { name: "b" }],
    }));

    await expect(collect({ fetchPage, maxItems: 1 })).rejects.toMatchObject({
      code: "item_limit",
      message: 'MCP server "srv" tools/list exceeded 1 catalog entries',
    });
  });

  it("enforces the item bound across cursor pages", async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) =>
      cursor === undefined
        ? { tools: [{ name: "a" }], nextCursor: "p2" }
        : { tools: [{ name: "b" }, { name: "c" }] },
    );

    await expect(collect({ fetchPage, maxItems: 2 })).rejects.toMatchObject({
      code: "item_limit",
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("fails closed when aggregate JSON bytes exceed the bound", async () => {
    const fetchPage = vi.fn(async () => ({
      tools: [{ name: "huge", pad: "x".repeat(40) }],
    }));

    await expect(
      collect({ fetchPage, maxAggregateBytes: 16 }),
    ).rejects.toMatchObject({
      code: "aggregate_size",
      message: 'MCP server "srv" tools/list exceeded 16 aggregate catalog bytes',
    });
  });

  it("fails closed when a catalog item cannot be JSON-measured", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const fetchPage = vi.fn(async () => ({ tools: [circular] }));

    await expect(
      collect({ fetchPage, maxAggregateBytes: 1_024 }),
    ).rejects.toMatchObject({
      code: "aggregate_size",
    });
  });

  it("counts an undefined catalog item as a measurable null", async () => {
    const fetchPage = vi.fn(async () => ({ tools: [undefined] }));
    await expect(
      collect({ fetchPage, maxAggregateBytes: 4 }),
    ).resolves.toEqual([undefined]);
  });

  it("retries transient page failures and reuses the same cursor", async () => {
    const logger = testLogger();
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({
        tools: [{ name: "a" }],
        nextCursor: "p2",
      })
      .mockRejectedValueOnce(new Error("page-2-transient"))
      .mockResolvedValueOnce({ tools: [{ name: "b" }] });

    await expect(
      collect({
        fetchPage,
        retry: { maxAttempts: 3, baseDelayMs: 0, logger },
      }),
    ).resolves.toEqual([{ name: "a" }, { name: "b" }]);
    expect(fetchPage.mock.calls.map((call) => call[0])).toEqual([
      undefined,
      undefined,
      "p2",
      "p2",
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'MCP server "srv" listTools attempt 1 failed; retrying',
    );
  });

  it("stops after the configured retry budget and returns the final error", async () => {
    const logger = testLogger();
    const errors = [
      new Error("first"),
      new Error("second"),
      new Error("final"),
    ];
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce(errors[0])
      .mockRejectedValueOnce(errors[1])
      .mockRejectedValueOnce(errors[2]);

    await expect(
      collect({
        fetchPage,
        retry: { maxAttempts: 3, baseDelayMs: 0, logger },
      }),
    ).rejects.toBe(errors[2]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("does not retry pagination or abort failures", async () => {
    const logger = testLogger();
    const pagination = new McpListPaginationError("bounded", "page_limit");
    await expect(
      collect({
        fetchPage: async () => {
          throw pagination;
        },
        retry: { maxAttempts: 3, baseDelayMs: 0, logger },
      }),
    ).rejects.toBe(pagination);

    const aborted = new AbortError("stopped");
    await expect(
      collect({
        fetchPage: async () => {
          throw aborted;
        },
        retry: { maxAttempts: 3, baseDelayMs: 0, logger },
      }),
    ).rejects.toBe(aborted);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("gives later pages only the remaining deadline, not a fresh budget", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: number[] = [];
      const fetchPage = vi.fn(
        async (cursor: string | undefined, callOptions: McpListPageCallOptions) => {
          timeouts.push(callOptions.timeout);
          if (cursor === undefined) {
            await new Promise((resolve) => {
              setTimeout(resolve, 40);
            });
            return { tools: [{ name: "a" }], nextCursor: "p2" };
          }
          return { tools: [{ name: "b" }] };
        },
      );

      const pending = collect({ fetchPage, deadlineMs: 100 });
      await vi.advanceTimersByTimeAsync(40);
      await pending;

      expect(timeouts).toHaveLength(2);
      expect(timeouts[0]).toBe(100);
      expect(timeouts[1]).toBeLessThanOrEqual(60);
      expect(fetchPage.mock.calls[1]?.[0]).toBe("p2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight page when the overall deadline elapses", async () => {
    vi.useFakeTimers();
    try {
      const fetchPage = vi.fn(
        async (
          _cursor: string | undefined,
          callOptions: McpListPageCallOptions,
        ) =>
          new Promise((_resolve, reject) => {
            callOptions.signal.addEventListener(
              "abort",
              () => {
                reject(callOptions.signal.reason ?? new Error("aborted"));
              },
              { once: true },
            );
          }),
      );

      const pending = collect({ fetchPage, deadlineMs: 25 });
      const rejection = expect(pending).rejects.toMatchObject({
        code: "timeout",
        message: 'MCP server "srv" tools/list timed out after 25ms',
      });
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(fetchPage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the walk immediately when the caller aborts", async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(
      async (
        _cursor: string | undefined,
        callOptions: McpListPageCallOptions,
      ) =>
        new Promise((_resolve, reject) => {
          callOptions.signal.addEventListener(
            "abort",
            () => {
              reject(callOptions.signal.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    const pending = collect({ fetchPage, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toSatisfy(
      (error) => error instanceof Error && isAbortLike(error),
    );
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("rejects immediately when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchPage = vi.fn();
    await expect(
      collect({ fetchPage, signal: controller.signal }),
    ).rejects.toSatisfy((error) => error instanceof Error);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("aborts retry backoff when the overall deadline elapses", async () => {
    vi.useFakeTimers();
    try {
      const logger = testLogger();
      const fetchPage = vi.fn(async () => {
        throw new Error("transient");
      });
      const pending = collect({
        fetchPage,
        deadlineMs: 30,
        retry: { maxAttempts: 3, baseDelayMs: 250, logger },
      });
      const rejection = expect(pending).rejects.toMatchObject({
        code: "timeout",
      });
      await vi.advanceTimersByTimeAsync(30);
      await rejection;
      expect(fetchPage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts retry backoff when the caller cancels", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const logger = testLogger();
      const fetchPage = vi.fn(async () => {
        throw new Error("transient");
      });
      const pending = collect({
        fetchPage,
        signal: controller.signal,
        retry: { maxAttempts: 3, baseDelayMs: 250, logger },
      });
      await Promise.resolve();
      controller.abort();
      await expect(pending).rejects.toSatisfy(
        (error) => error instanceof Error && isAbortLike(error),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid numeric bounds", async () => {
    const fetchPage = vi.fn();
    await expect(collect({ fetchPage, maxPages: 0 })).rejects.toThrow(
      "maxPages must be a safe integer between",
    );
    await expect(
      collect({ fetchPage, maxPages: MAX_MCP_LIST_PAGES + 1 }),
    ).rejects.toThrow("maxPages must be a safe integer between");
    await expect(collect({ fetchPage, maxItems: 1.5 })).rejects.toThrow(
      "maxItems must be a safe integer between",
    );
    await expect(
      collect({ fetchPage, maxItems: MAX_MCP_LIST_ITEMS + 1 }),
    ).rejects.toThrow("maxItems must be a safe integer between");
    await expect(collect({ fetchPage, maxCursorBytes: 0 })).rejects.toThrow(
      "maxCursorBytes must be a safe integer between",
    );
    await expect(
      collect({ fetchPage, maxAggregateBytes: -1 }),
    ).rejects.toThrow("maxAggregateBytes must be a safe integer between");
    await expect(
      collectMcpListPages({
        serverName: "srv",
        method: "tools/list",
        itemsKey: "tools",
        deadlineMs: 0,
        fetchPage,
      }),
    ).rejects.toThrow("deadlineMs must be a positive finite number");
    await expect(
      collectMcpListPages({
        serverName: "srv",
        method: "tools/list",
        itemsKey: "tools",
        deadlineMs: Number.NaN,
        fetchPage,
      }),
    ).rejects.toThrow("deadlineMs must be a positive finite number");
    await expect(
      collect({
        fetchPage,
        retry: { maxAttempts: 0, baseDelayMs: 1 },
      }),
    ).rejects.toThrow("retry.maxAttempts must be a positive safe integer");
    await expect(
      collect({
        fetchPage,
        retry: { maxAttempts: 1, baseDelayMs: Number.NaN },
      }),
    ).rejects.toThrow("retry.baseDelayMs must be a finite number >= 0");
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("uses the production caps when callers omit optional bounds", async () => {
    const fetchPage = vi.fn(async () => ({ tools: [] }));
    await expect(
      collectMcpListPages({
        serverName: "srv",
        method: "tools/list",
        itemsKey: "tools",
        deadlineMs: 1_000,
        fetchPage,
      }),
    ).resolves.toEqual([]);
    expect(MAX_MCP_LIST_PAGES).toBe(100);
    expect(MAX_MCP_LIST_ITEMS).toBe(1_000);
    expect(MAX_MCP_LIST_AGGREGATE_BYTES).toBe(5 * 1024 * 1024);
  });
});

function isAbortLike(error: Error): boolean {
  return error.name === "AbortError" || error instanceof AbortError;
}
