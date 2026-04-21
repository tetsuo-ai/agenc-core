import { describe, expect, it, vi } from "vitest";
import { RetryableError, SerialBatchEventUploader } from "./serial-batch-uploader.js";

describe("SerialBatchEventUploader", () => {
  it("batches items and flushes in order", async () => {
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

  it("retries failed batches and preserves order", async () => {
    vi.useFakeTimers();
    const sent: number[][] = [];
    let failures = 0;
    const uploader = new SerialBatchEventUploader<number>({
      maxBatchSize: 2,
      maxQueueSize: 10,
      send: async (batch) => {
        if (failures < 1) {
          failures += 1;
          throw new RetryableError("retry");
        }
        sent.push([...batch]);
      },
      baseDelayMs: 5,
      maxDelayMs: 5,
      jitterMs: 0,
    });

    await uploader.enqueue([1, 2]);
    const flushPromise = uploader.flush();
    await vi.advanceTimersByTimeAsync(5);
    await flushPromise;

    expect(sent).toEqual([[1, 2]]);
    vi.useRealTimers();
  });

  it("drops batches after max consecutive failures", async () => {
    vi.useFakeTimers();
    const dropped = vi.fn();
    const uploader = new SerialBatchEventUploader<number>({
      maxBatchSize: 1,
      maxQueueSize: 10,
      send: async () => {
        throw new RetryableError("retry");
      },
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitterMs: 0,
      maxConsecutiveFailures: 2,
      onBatchDropped: dropped,
    });

    await uploader.enqueue([1]);
    const flushPromise = uploader.flush();
    await vi.advanceTimersByTimeAsync(2);
    await flushPromise;

    expect(uploader.droppedBatchCount).toBe(1);
    expect(dropped).toHaveBeenCalledWith(1, 2);
    vi.useRealTimers();
  });
});

