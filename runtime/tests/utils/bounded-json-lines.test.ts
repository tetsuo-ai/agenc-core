import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { BoundedJsonLineReader } from "../../src/utils/bounded-json-lines.js";

function createReader(maxLineBytes: number) {
  const input = new PassThrough();
  const lines: string[] = [];
  const errors: Error[] = [];
  const closed = vi.fn();
  const reader = new BoundedJsonLineReader({
    input,
    maxLineBytes,
    onLine: (line) => { lines.push(line); },
    onError: (error) => { errors.push(error); },
    onClose: closed,
  });
  reader.start();
  return { input, lines, errors, closed, reader };
}

describe("BoundedJsonLineReader", () => {
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid cap %s before listening",
    (maxLineBytes) => {
      const input = new PassThrough();
      expect(() => new BoundedJsonLineReader({
        input,
        maxLineBytes,
        onLine: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
      })).toThrow(RangeError);
      expect(input.listenerCount("data")).toBe(0);
      input.destroy();
    },
  );

  it("accepts empty lines with a zero-byte cap and rejects any payload", () => {
    const fixture = createReader(0);
    fixture.input.write("\r\n\n\r");
    expect(fixture.lines).toEqual(["", "", ""]);
    fixture.input.write("x\n");
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.input.destroyed).toBe(true);
    expect(fixture.closed).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 3, 4, 9, 64])("matches readline delimiters and UTF-8 with %s-byte chunks", async (chunkBytes) => {
    const fixture = createReader(64);
    const referenceInput = new PassThrough();
    const referenceReader = createInterface({ input: referenceInput, crlfDelay: Infinity, terminal: false });
    const expected: string[] = [];
    referenceReader.on("line", (line) => { expected.push(line); });
    const referenceClosed = once(referenceReader, "close");
    const data = Buffer.from("α🛰\r\n\nsecond\rthird\r\r\nfourth\nfinalé", "utf8");
    for (let offset = 0; offset < data.length; offset += chunkBytes) {
      const chunk = data.subarray(offset, offset + chunkBytes);
      fixture.input.write(chunk);
      referenceInput.write(chunk);
    }
    fixture.input.end();
    referenceInput.end();
    await referenceClosed;
    await nextTick();
    expect(fixture.lines).toEqual(expected);
    expect(fixture.errors).toEqual([]);
    expect(fixture.closed).toHaveBeenCalledTimes(1);
  });

  it("bounds an accumulated line across many tiny chunks", () => {
    const fixture = createReader(4096);
    for (let count = 0; count < 4096; count += 1) fixture.input.write("x");
    fixture.input.write("\n");
    expect(fixture.lines).toEqual(["x".repeat(4096)]);
    expect(fixture.errors).toEqual([]);
    for (let count = 0; count < 4096; count += 1) fixture.input.write("y");
    fixture.input.write("z\n");
    expect(fixture.lines).toHaveLength(1);
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.input.destroyed).toBe(true);
  });

  it("copies a trailing fragment rather than retaining the input chunk", () => {
    const fixture = createReader(64);
    const chunk = Buffer.from("short\ntail");
    fixture.input.write(chunk);
    chunk.fill(0);
    fixture.input.write("\n");
    expect(fixture.lines).toEqual(["short", "tail"]);
    fixture.reader.close();
    fixture.input.destroy();
  });

  it("measures decoded string chunks in UTF-8 bytes", () => {
    const fixture = createReader(4);
    fixture.input.setEncoding("utf8");
    fixture.input.write("é");
    fixture.input.write("é\r");
    fixture.input.write("\n🛰\n");
    expect(fixture.lines).toEqual(["éé", "🛰"]);
    expect(fixture.errors).toEqual([]);
    fixture.input.write("ééx\n");
    expect(fixture.lines).toHaveLength(2);
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.input.destroyed).toBe(true);
  });

  it("stops before later frames when the line callback closes the reader", () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const closed = vi.fn();
    const reader = new BoundedJsonLineReader({
      input,
      maxLineBytes: 64,
      onLine(line) {
        lines.push(line);
        reader.close();
      },
      onError: vi.fn(),
      onClose: closed,
    });
    reader.start();
    input.write("first\nsecond\npartial");
    expect(lines).toEqual(["first"]);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(() => reader.start()).toThrow(/already started or closed/);
    input.destroy();
  });

  it("rejects restarting a live reader", () => {
    const fixture = createReader(64);
    expect(() => fixture.reader.start()).toThrow(/already started or closed/);
    fixture.reader.close();
    fixture.reader.close();
    expect(fixture.closed).toHaveBeenCalledTimes(1);
    fixture.input.destroy();
  });

  it("discards partial input and removes listeners on stream error", async () => {
    const fixture = createReader(64);
    const error = new Error("input failed");
    fixture.input.write("partial");
    fixture.input.destroy(error);
    await nextTick();
    expect(fixture.lines).toEqual([]);
    expect(fixture.errors).toEqual([error]);
    expect(fixture.closed).toHaveBeenCalledTimes(1);
    for (const event of ["data", "end", "close", "error"]) {
      expect(fixture.input.listenerCount(event)).toBe(0);
    }
  });

  it("discards partial input on abrupt stream close", async () => {
    const fixture = createReader(64);
    fixture.input.write("partial");
    fixture.input.destroy();
    await nextTick();
    expect(fixture.lines).toEqual([]);
    expect(fixture.errors).toEqual([]);
    expect(fixture.closed).toHaveBeenCalledTimes(1);
  });

  it("destroys input even when the overflow close callback throws", () => {
    const input = new PassThrough();
    const error = new Error("close failed");
    const reader = new BoundedJsonLineReader({
      input,
      maxLineBytes: 1,
      onLine: vi.fn(),
      onError: vi.fn(),
      onClose: () => { throw error; },
    });
    reader.start();
    expect(() => input.write("xx\n")).toThrow(error);
    expect(input.destroyed).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    reader.close();
  });
});
