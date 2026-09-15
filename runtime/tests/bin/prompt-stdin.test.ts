import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readPromptStdin } from "../../src/bin/prompt-stdin.js";

describe("prompt stdin", () => {
  it("preserves whitespace and split Unicode at EOF", async () => {
    const input = new PassThrough();
    const reading = readPromptStdin(input, new AbortController().signal);
    const prompt = "  cleanup α\n\t雪\n\n";
    for (const byte of Buffer.from(prompt)) input.write(Buffer.from([byte]));
    input.end();
    await expect(reading).resolves.toBe(prompt);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("cancels while idle without waiting for a chunk or destroying stdin", async () => {
    const input = new PassThrough();
    const abort = new AbortController();
    const reason = new Error("cancel startup");
    const reading = readPromptStdin(input, abort.signal);
    abort.abort(reason);
    await expect(reading).rejects.toBe(reason);
    expect(input.destroyed).toBe(false);
    for (const event of ["data", "end", "close", "error"]) {
      expect(input.listenerCount(event)).toBe(0);
    }
    input.destroy();
  });

  it("does not consume an already canceled input", async () => {
    const input = new PassThrough();
    input.write("pending");
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(readPromptStdin(input, abort.signal)).rejects.toThrow("cancelled");
    expect(input.read().toString()).toBe("pending");
    input.destroy();
  });

  it("rejects premature close and stream errors", async () => {
    for (const error of [undefined, new Error("read failed")]) {
      const input = new PassThrough();
      const reading = readPromptStdin(input, new AbortController().signal);
      input.destroy(error);
      await expect(reading).rejects.toThrow(error?.message ?? "before prompt EOF");
    }
  });
});
