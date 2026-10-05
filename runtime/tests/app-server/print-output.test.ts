import { describe, expect, it } from "vitest";
import { PrintOutput, PRINT_OUTPUT_MAX_BYTES, PRINT_OUTPUT_MAX_FRAMES } from "../../src/app-server/print-output.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };

describe("resident print delivery", () => {
  it("orders mixed streams and UTF-8 bytes, and waits for both write and ack", async () => {
    const frames: JsonObject[] = [];
    let release!: () => void;
    const output = new PrintOutput("run", message => { frames.push(message); return new Promise<void>(resolve => { release = resolve; }); }, error => { throw error; });
    output.write("stdout", "π🌍"); output.write("stderr", "error\n");
    let flushed = false;
    const flush = output.flush().then(() => { flushed = true; });
    await tick(); expect(frames).toHaveLength(1);
    output.acknowledge(1); await tick(); expect(frames).toHaveLength(1); expect(flushed).toBe(false);
    release(); await tick(); expect(frames).toHaveLength(2);
    expect(frames.map(frame => frame.params)).toEqual([
      { invocationId: "run", sequence: 1, stream: "stdout", data: "π🌍" },
      { invocationId: "run", sequence: 2, stream: "stderr", data: "error\n" },
    ]);
    release(); await tick(); expect(flushed).toBe(false);
    output.acknowledge(2); await flush; expect(output.pendingBytes).toBe(0);
    expect(() => output.acknowledge(2)).toThrow("invalid");
  });

  it.each(["bytes", "frames"])("bounds retained %s while the reader is stalled", async limit => {
    let aborted: Error | undefined;
    const output = new PrintOutput("run", async () => {}, error => { aborted = error; });
    if (limit === "bytes") output.write("stdout", "x".repeat(PRINT_OUTPUT_MAX_BYTES));
    else for (let i = 0; i < PRINT_OUTPUT_MAX_FRAMES; i++) output.write("stdout", "x");
    expect(output.pendingBytes).toBeLessThanOrEqual(PRINT_OUTPUT_MAX_BYTES);
    expect(output.pendingFrames).toBeLessThanOrEqual(PRINT_OUTPUT_MAX_FRAMES);
    const flush = output.flush();
    output.write("stdout", "overflow");
    await expect(flush).rejects.toThrow("delivery limit");
    expect(aborted?.message).toContain("delivery limit");
    for (let i = 0; i < 1000; i++) output.write("stdout", "ignored");
    expect(output.pendingBytes).toBe(0); expect(output.pendingFrames).toBe(0);
  });

  it("preserves surrogate pairs across frame boundaries within the encoded limit", async () => {
    const chunks: string[] = [];
    let output!: PrintOutput;
    output = new PrintOutput("run", message => {
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(PRINT_OUTPUT_MAX_BYTES);
      const p = message.params as JsonObject; chunks.push(String(p.data)); output.acknowledge(p.sequence as number);
    }, error => { throw error; });
    const value = "x".repeat(16_383) + "🌍" + "\0".repeat(20_000);
    output.write("stdout", value); await output.flush();
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))).toEqual(Buffer.from(value));
  });

  it("cancellation wakes a stalled write and rejects flush", async () => {
    const output = new PrintOutput("run", () => new Promise<void>(() => {}), () => {});
    output.write("stdout", "pending");
    const flushed = output.flush();
    output.fail(new Error("cancelled"));
    await expect(flushed).rejects.toThrow("cancelled");
    expect(output.pendingFrames).toBe(0);
  });
});
