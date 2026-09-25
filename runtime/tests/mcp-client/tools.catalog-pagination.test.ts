import { describe, expect, test, vi } from "vitest";
import {
  createToolBridge as createToolBridgeWithEnvironment,
} from "./tools.js";
import { computeMCPToolCatalogSha256 } from "./supply-chain.js";
import { McpListPaginationError } from "./list-pagination.js";

type ToolBridgeOptions = Parameters<typeof createToolBridgeWithEnvironment>[3];
type TestToolBridgeOptions = Omit<ToolBridgeOptions, "environment"> &
  Partial<Pick<ToolBridgeOptions, "environment">>;

function createToolBridge(
  client: Parameters<typeof createToolBridgeWithEnvironment>[0],
  serverName: string,
  logger?: Parameters<typeof createToolBridgeWithEnvironment>[2],
  options: TestToolBridgeOptions = {},
) {
  const { environment = {}, ...rest } = options;
  return createToolBridgeWithEnvironment(client, serverName, logger, {
    ...rest,
    environment,
  });
}

describe("createToolBridge catalog pagination", () => {
  test("registers every tool from a two-page catalog in protocol order", async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [{ name: "alpha", description: "first page" }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        tools: [{ name: "beta", description: "second page" }],
      });

    const bridge = await createToolBridge(
      { listTools, close: async () => {} },
      "srv",
    );

    expect(bridge.tools.map((tool) => tool.name)).toEqual([
      "mcp.srv.alpha",
      "mcp.srv.beta",
    ]);
    expect(listTools).toHaveBeenNthCalledWith(
      1,
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(listTools).toHaveBeenNthCalledWith(
      2,
      { cursor: "page-2" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test("passes the exact prior nextCursor to later tools/list pages", async () => {
    const listTools = vi.fn(
      async (params: { cursor?: string } | undefined) => {
        if (params === undefined) {
          return {
            tools: [{ name: "one" }],
            nextCursor: "exact-cursor-token",
          };
        }
        if (params.cursor === "exact-cursor-token") {
          return { tools: [{ name: "two" }], nextCursor: "page-3" };
        }
        expect(params).toEqual({ cursor: "page-3" });
        return { tools: [{ name: "three" }] };
      },
    );

    const bridge = await createToolBridge(
      { listTools, close: async () => {} },
      "srv",
    );

    expect(bridge.tools.map((tool) => tool.name)).toEqual([
      "mcp.srv.one",
      "mcp.srv.two",
      "mcp.srv.three",
    ]);
    expect(listTools.mock.calls.map((call) => call[0])).toEqual([
      undefined,
      { cursor: "exact-cursor-token" },
      { cursor: "page-3" },
    ]);
  });

  test("hashes the complete collected catalog, not the first page alone", async () => {
    const defaultSchema = { type: "object", properties: {} };
    const completePin = computeMCPToolCatalogSha256([
      { name: "alpha", description: "first page", inputSchema: defaultSchema },
      { name: "beta", description: "second page", inputSchema: defaultSchema },
    ]).sha256;
    const firstPagePin = computeMCPToolCatalogSha256([
      { name: "alpha", description: "first page", inputSchema: defaultSchema },
    ]).sha256;

    const pagedClient = {
      listTools: vi
        .fn()
        .mockResolvedValueOnce({
          tools: [{ name: "alpha", description: "first page" }],
          nextCursor: "page-2",
        })
        .mockResolvedValueOnce({
          tools: [{ name: "beta", description: "second page" }],
        }),
      close: async () => {},
    };

    const accepted = await createToolBridge(pagedClient, "srv", undefined, {
      serverConfig: { pinnedCatalogSha256: completePin },
    });
    expect(accepted.tools.map((tool) => tool.name)).toEqual([
      "mcp.srv.alpha",
      "mcp.srv.beta",
    ]);

    await expect(
      createToolBridge(
        {
          listTools: vi
            .fn()
            .mockResolvedValueOnce({
              tools: [{ name: "alpha", description: "first page" }],
              nextCursor: "page-2",
            })
            .mockResolvedValueOnce({
              tools: [{ name: "beta", description: "second page" }],
            }),
          close: async () => {},
        },
        "srv",
        undefined,
        { serverConfig: { pinnedCatalogSha256: firstPagePin } },
      ),
    ).rejects.toThrow(/tool catalog digest mismatch/);
  });

  test("filters and hashes only after every page is collected", async () => {
    const filteredPin = computeMCPToolCatalogSha256([
      {
        name: "keep",
        description: "kept",
        inputSchema: { type: "object", properties: {} },
      },
    ]).sha256;
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [{ name: "keep", description: "kept" }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        tools: [{ name: "drop", description: "denied later" }],
      });

    const bridge = await createToolBridge(
      { listTools, close: async () => {} },
      "srv",
      undefined,
      {
        serverConfig: {
          deniedTools: ["drop"],
          pinnedCatalogSha256: filteredPin,
        },
      },
    );

    expect(bridge.tools.map((tool) => tool.name)).toEqual(["mcp.srv.keep"]);
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  test("fails closed on a repeated tools/list cursor", async () => {
    const listTools = vi.fn(async () => ({
      tools: [{ name: "loop" }],
      nextCursor: "again",
    }));

    await expect(
      createToolBridge({ listTools, close: async () => {} }, "srv"),
    ).rejects.toBeInstanceOf(McpListPaginationError);
    await expect(
      createToolBridge(
        {
          listTools: vi.fn(async () => ({
            tools: [{ name: "loop" }],
            nextCursor: "again",
          })),
          close: async () => {},
        },
        "srv",
      ),
    ).rejects.toThrow('MCP server "srv" repeated a tools/list cursor');
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  test("fails closed when tools/list pagination exceeds its page bound", async () => {
    const listTools = vi.fn(async (params: { cursor?: string } | undefined) => ({
      tools: [{ name: params?.cursor ?? "first" }],
      nextCursor: params?.cursor === undefined ? "page-2" : "page-3",
    }));

    await expect(
      createToolBridge(
        { listTools, close: async () => {} },
        "srv",
        undefined,
        { maxListPages: 2 },
      ),
    ).rejects.toMatchObject({
      code: "page_limit",
      message: 'MCP server "srv" tools/list exceeded 2 pages',
    });
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  test("fails closed when the collected catalog exceeds its item bound", async () => {
    await expect(
      createToolBridge(
        {
          listTools: async () => ({
            tools: [{ name: "a" }, { name: "b" }],
          }),
          close: async () => {},
        },
        "srv",
        undefined,
        { maxListItems: 1 },
      ),
    ).rejects.toMatchObject({ code: "item_limit" });
  });

  test("fails closed when the collected catalog exceeds its aggregate byte bound", async () => {
    await expect(
      createToolBridge(
        {
          listTools: async () => ({
            tools: [{ name: "huge", pad: "x".repeat(50) }],
          }),
          close: async () => {},
        },
        "srv",
        undefined,
        { maxListAggregateBytes: 8 },
      ),
    ).rejects.toMatchObject({ code: "aggregate_size" });
  });

  test("retries a later page with the same cursor and no fresh deadline", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: number[] = [];
      const listTools = vi.fn(
        async (
          params: { cursor?: string } | undefined,
          opts: { timeout: number },
        ) => {
          timeouts.push(opts.timeout);
          if (params === undefined) {
            return {
              tools: [{ name: "a" }],
              nextCursor: "page-2",
            };
          }
          if (listTools.mock.calls.length === 2) {
            throw new Error("transient page-2");
          }
          expect(params).toEqual({ cursor: "page-2" });
          return { tools: [{ name: "b" }] };
        },
      );
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const pending = createToolBridge(
        { listTools, close: async () => {} },
        "srv",
        logger,
        { listToolsTimeoutMs: 1_000 },
      );
      await vi.advanceTimersByTimeAsync(250);
      const bridge = await pending;

      expect(bridge.tools.map((tool) => tool.name)).toEqual([
        "mcp.srv.a",
        "mcp.srv.b",
      ]);
      expect(listTools.mock.calls.map((call) => call[0])).toEqual([
        undefined,
        { cursor: "page-2" },
        { cursor: "page-2" },
      ]);
      expect(timeouts[2]).toBeLessThan(timeouts[0]!);
      expect(logger.warn).toHaveBeenCalledWith(
        'MCP server "srv" listTools attempt 1 failed; retrying',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("times out the whole pagination walk instead of each page", async () => {
    vi.useFakeTimers();
    try {
      const listTools = vi.fn(
        async (
          _params: { cursor?: string } | undefined,
          opts: { signal: AbortSignal; timeout: number },
        ) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener(
              "abort",
              () => {
                reject(opts.signal.reason ?? new Error("aborted"));
              },
              { once: true },
            );
          }),
      );

      const pending = createToolBridge(
        { listTools, close: async () => {} },
        "srv",
        undefined,
        { listToolsTimeoutMs: 20 },
      );
      const rejection = expect(pending).rejects.toThrow(
        /tools\/list timed out after 20ms/,
      );
      await vi.advanceTimersByTimeAsync(20);
      await rejection;
      expect(listTools).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancels catalog pagination promptly when the caller aborts", async () => {
    const controller = new AbortController();
    const listTools = vi.fn(
      async (
        _params: { cursor?: string } | undefined,
        opts: { signal: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener(
            "abort",
            () => {
              reject(opts.signal.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    const pending = createToolBridge(
      { listTools, close: async () => {} },
      "srv",
      undefined,
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(listTools).toHaveBeenCalledOnce();
  });
});
