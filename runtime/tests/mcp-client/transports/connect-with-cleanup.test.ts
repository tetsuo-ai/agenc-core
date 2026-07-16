import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import {
  connectMCPClientWithCleanup,
  MCPTransportCleanupError,
} from "./connect-with-cleanup.js";

describe("connectMCPClientWithCleanup", () => {
  it("preserves the connection error after awaiting successful cleanup", async () => {
    const connectError = new Error("connect failed");
    let releaseCleanup: (() => void) | undefined;
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const close = vi.fn(async () => {
      cleanupStarted.resolve();
      await cleanupGate;
    });
    const client = {
      connect: vi.fn(async () => {
        throw connectError;
      }),
      close,
    };

    const result = connectMCPClientWithCleanup(client, {}, {
      description: "MCP test connect",
      timeoutMs: 10_000,
    });
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await cleanupStarted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCleanup?.();

    await expect(result).rejects.toBe(connectError);
    expect(close).toHaveBeenCalledOnce();
  });

  it("aggregates the original connection error with async cleanup failure", async () => {
    const connectError = new Error("connect failed");
    const cleanupError = new Error("close failed asynchronously");
    const close = vi.fn(async () => {
      await Promise.resolve();
      throw cleanupError;
    });
    const client = {
      connect: vi.fn(async () => {
        throw connectError;
      }),
      close,
    };

    const result = connectMCPClientWithCleanup(client, {}, {
      description: "MCP test connect",
      timeoutMs: 10_000,
    });
    const error: unknown = await result.catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(MCPTransportCleanupError);
    expect((error as AggregateError).message).toMatch(/cleanup also failed/i);
    expect((error as AggregateError).errors).toEqual([
      connectError,
      cleanupError,
    ]);
    expect((error as Error).cause).toBe(connectError);
    expect(close).toHaveBeenCalledOnce();
  });

  it("turns a timeout into the causal error when cleanup also fails", async () => {
    const cleanupError = new Error("timeout cleanup failed");
    const close = vi.fn(async () => {
      throw cleanupError;
    });
    const client = {
      connect: vi.fn(() => new Promise<void>(() => {})),
      close,
    };

    const result = connectMCPClientWithCleanup(client, {}, {
      description: 'MCP stdio connect to "slow"',
      timeoutMs: 5,
    });
    const error: unknown = await result.catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.cause).toBeInstanceOf(Error);
    expect((aggregate.cause as Error).message).toMatch(
      /MCP stdio connect to "slow" timed out after 5ms/,
    );
    expect(aggregate.errors).toEqual([aggregate.cause, cleanupError]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps close retryable after a successful connection", async () => {
    const closeError = new Error("first close did not prove shutdown");
    const close = vi
      .fn()
      .mockRejectedValueOnce(closeError)
      .mockResolvedValue(undefined);
    const client = {
      connect: vi.fn(async () => {}),
      close,
    };

    await connectMCPClientWithCleanup(client, {}, {
      description: "MCP successful connect",
      timeoutMs: 10_000,
    });

    await expect(client.close()).rejects.toBe(closeError);
    await expect(client.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("observes the SDK initialization cleanup and preserves its failure", async () => {
    const cleanupError = new Error("transport close failed");
    const close = vi.fn(async () => {
      await Promise.resolve();
      throw cleanupError;
    });
    const transport: Transport = {
      async start() {},
      async send(message: JSONRPCMessage) {
        if (!("id" in message) || !("method" in message)) return;
        queueMicrotask(() => {
          transport.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "unsupported-test-version",
              capabilities: {},
              serverInfo: { name: "rejecting-test-server", version: "1.0.0" },
            },
          });
        });
      },
      close,
    };
    const client = new Client(
      { name: "agenc-cleanup-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const result = connectMCPClientWithCleanup(client, transport, {
        description: "MCP installed-SDK connect",
        timeoutMs: 10_000,
      });
      const error: unknown = await result.catch((failure: unknown) => failure);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandledRejections).toEqual([]);
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(aggregate.cause);
      expect((aggregate.cause as Error).message).toMatch(
        /protocol version is not supported/i,
      );
      expect(aggregate.errors[1]).toBe(cleanupError);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
