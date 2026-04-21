import { afterEach, describe, expect, it, vi } from "vitest";
import { RetryableError, SerialBatchEventUploader } from "./serial-batch-uploader.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SerialBatchEventUploader", () => {
  it("batches items by count and flushes in order", async () => {
    const sent: number[][] = [];
    const uploader = new SerialBatchEventUploader<number>({
      maxBatchSize: 2,
      maxQueueSize: 10,
      send: async (batch) => {
        sent.push([...batch]);
      },
      baseDelayMs: 1,
      maxDelayMs: 8,
      jitterMs: 0,
    });

    await uploader.enqueue([1, 2, 3]);
    await uploader.flush();

    expect(sent).toEqual([[1, 2], [3]]);
  });

  it("retries failed batches at the front of the queue before later events", async () => {
    vi.useFakeTimers();

    const attempts: number[][] = [];
    let firstBatchAttempts = 0;
    const uploader = new SerialBatchEventUploader<number>({
      maxBatchSize: 2,
      maxQueueSize: 10,
      send: async (batch) => {
        attempts.push([...batch]);
        if (batch[0] === 1 && firstBatchAttempts === 0) {
          firstBatchAttempts += 1;
          throw new RetryableError("retry");
        }
      },
      baseDelayMs: 5,
      maxDelayMs: 5,
      jitterMs: 0,
    });

    await uploader.enqueue([1, 2, 3]);
    const flushPromise = uploader.flush();

    await vi.advanceTimersByTimeAsync(5);
    await flushPromise;

    expect(attempts).toEqual([[1, 2], [1, 2], [3]]);
  });

  it("clamps retry-after delays to the configured ceiling", async () => {
    vi.useFakeTimers();

    const send = vi
      .fn<(_: number[]) => Promise<void>>()
      .mockRejectedValueOnce(new RetryableError("retry", 50_000))
      .mockResolvedValue(undefined);

    const uploader = new SerialBatchEventUploader<number>({
      maxBatchSize: 1,
      maxQueueSize: 10,
      send,
      baseDelayMs: 5,
      maxDelayMs: 25,
      jitterMs: 0,
    });

    await uploader.enqueue([1]);
    const flushPromise = uploader.flush();

    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromise;

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drops a failed batch after the configured retry budget and resets failures for the next batch", async () => {
    vi.useFakeTimers();

    const attempts: number[][] = [];
    const delivered: number[][] = [];
    const dropped = vi.fn();
    const attemptCounts = new Map<number, number>();
    const uploader = new SerialBatchEventUploader<number>({
      maxBatchSize: 1,
      maxQueueSize: 10,
      send: async (batch) => {
        attempts.push([...batch]);
        const id = batch[0];
        const count = (attemptCounts.get(id) ?? 0) + 1;
        attemptCounts.set(id, count);

        if (id === 1) {
          throw new RetryableError("retry");
        }
        if (id === 2 && count === 1) {
          throw new RetryableError("retry");
        }
        delivered.push([...batch]);
      },
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitterMs: 0,
      maxConsecutiveFailures: 2,
      onBatchDropped: dropped,
    });

    await uploader.enqueue([1, 2]);
    const flushPromise = uploader.flush();

    await vi.advanceTimersByTimeAsync(2);
    await flushPromise;

    expect(attempts).toEqual([[1], [1], [2], [2]]);
    expect(delivered).toEqual([[2]]);
    expect(uploader.droppedBatchCount).toBe(1);
    expect(dropped).toHaveBeenCalledWith(1, 2);
  });

  it("skips unserializable items while respecting byte-bounded batches", async () => {
    const sent: unknown[][] = [];
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const uploader = new SerialBatchEventUploader<unknown>({
      maxBatchSize: 4,
      maxBatchBytes: 10,
      maxQueueSize: 10,
      send: async (batch) => {
        sent.push([...batch]);
      },
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitterMs: 0,
    });

    await uploader.enqueue([circular, "aa", "bbbb", "c"]);
    await uploader.flush();

    expect(sent).toEqual([["aa", "bbbb"], ["c"]]);
    expect(uploader.pendingCount).toBe(0);
  });

  it("close resolves an in-flight flush and reports the queue depth at close time", async () => {
    vi.useFakeTimers();

    const uploader = new SerialBatchEventUploader<number>({
      maxBatchSize: 1,
      maxQueueSize: 10,
      send: async () => {
        throw new RetryableError("retry");
      },
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
    });

    await uploader.enqueue([1, 2]);
    const flushPromise = uploader.flush();

    await vi.advanceTimersByTimeAsync(0);
    uploader.close();
    await flushPromise;

    expect(uploader.pendingCount).toBe(2);
    expect(uploader.droppedBatchCount).toBe(0);
  });
});
