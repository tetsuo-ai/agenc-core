import { describe, expect, it, vi } from "vitest";

import { connectMCPClientWithCleanup } from "./connect-with-cleanup.js";

describe("connectMCPClientWithCleanup", () => {
  it("preserves the connection error after awaiting successful cleanup", async () => {
    const connectError = new Error("connect failed");
    let releaseCleanup: (() => void) | undefined;
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const client = {
      connect: vi.fn(async () => {
        throw connectError;
      }),
      close: vi.fn(async () => {
        cleanupStarted.resolve();
        await cleanupGate;
      }),
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
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("aggregates the original connection error with async cleanup failure", async () => {
    const connectError = new Error("connect failed");
    const cleanupError = new Error("close failed asynchronously");
    const client = {
      connect: vi.fn(async () => {
        throw connectError;
      }),
      close: vi.fn(async () => {
        await Promise.resolve();
        throw cleanupError;
      }),
    };

    const result = connectMCPClientWithCleanup(client, {}, {
      description: "MCP test connect",
      timeoutMs: 10_000,
    });
    const error: unknown = await result.catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(/cleanup also failed/i);
    expect((error as AggregateError).errors).toEqual([
      connectError,
      cleanupError,
    ]);
    expect((error as Error).cause).toBe(connectError);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("turns a timeout into the causal error when cleanup also fails", async () => {
    const cleanupError = new Error("timeout cleanup failed");
    const client = {
      connect: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn(async () => {
        throw cleanupError;
      }),
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
  });
});
