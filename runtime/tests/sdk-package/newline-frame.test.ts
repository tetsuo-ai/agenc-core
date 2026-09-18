/**
 * Unit tests for the SDK subprocess newline decoder (#2092).
 * Uses a 64-byte ceiling so the exact-limit / overflow rules stay hermetic
 * without allocating the production 16 MiB bound.
 */

import { setImmediate as nextTick } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { AGENC_SDK_MAX_FRAME_BYTES } from "../../../packages/agenc-sdk/src/limits";
import { SdkNewlineFrameDecoder } from "../../../packages/agenc-sdk/src/newline-frame";

const LIMIT = 64;

describe("SdkNewlineFrameDecoder", () => {
  it("defaults to the shared 16 MiB SDK ceiling", () => {
    expect(new SdkNewlineFrameDecoder().maxBytes).toBe(AGENC_SDK_MAX_FRAME_BYTES);
    expect(AGENC_SDK_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
  });

  it("accepts an exact-limit payload and then a later frame", () => {
    const decoder = new SdkNewlineFrameDecoder(LIMIT);
    expect(decoder.push(Buffer.concat([Buffer.alloc(LIMIT, 0x61), Buffer.from("\n")]))).toEqual([
      "a".repeat(LIMIT),
    ]);
    expect(decoder.overflowed).toBe(false);
    expect(decoder.push(Buffer.from('{"type":"result"}\n'))).toEqual(['{"type":"result"}']);
  });

  it("rejects a limit-plus-one payload when the newline is in the same chunk", () => {
    const decoder = new SdkNewlineFrameDecoder(LIMIT);
    expect(
      decoder.push(
        Buffer.concat([Buffer.alloc(LIMIT + 1, 0x61), Buffer.from("\n{\"ok\":true}\n")]),
      ),
    ).toEqual([]);
    expect(decoder.overflowed).toBe(true);
    expect(decoder.push(Buffer.from('{"type":"result"}\n'))).toEqual([]);
  });

  it("rejects overflow when the newline arrives in a later chunk", async () => {
    const decoder = new SdkNewlineFrameDecoder(LIMIT);
    expect(decoder.push(Buffer.alloc(LIMIT, 0x61))).toEqual([]);
    expect(decoder.overflowed).toBe(false);
    await nextTick();
    expect(decoder.push(Buffer.from("x\n"))).toEqual([]);
    expect(decoder.overflowed).toBe(true);
  });

  it("rejects a newline-free writer as soon as the payload crosses the ceiling", () => {
    const decoder = new SdkNewlineFrameDecoder(LIMIT);
    expect(decoder.push(Buffer.alloc(LIMIT + 1, 0x61))).toEqual([]);
    expect(decoder.overflowed).toBe(true);
    expect(decoder.flush()).toBeUndefined();
  });

  it("strips a single trailing CR from CRLF-delimited frames", () => {
    const decoder = new SdkNewlineFrameDecoder(LIMIT);
    expect(decoder.push(Buffer.from('{"type":"result","finalMessage":"crlf"}\r\n'))).toEqual([
      '{"type":"result","finalMessage":"crlf"}',
    ]);
  });

  it("reassembles a multibyte UTF-8 sequence split across chunks", () => {
    const decoder = new SdkNewlineFrameDecoder(LIMIT);
    const frame = Buffer.from('{"type":"result","finalMessage":"é🛰"}\n');
    const split = frame.indexOf(Buffer.from("🛰")) + 1;
    expect(decoder.push(frame.subarray(0, split))).toEqual([]);
    expect(decoder.push(frame.subarray(split))).toEqual([
      '{"type":"result","finalMessage":"é🛰"}',
    ]);
  });

  it("parses multiple complete frames from a single chunk", () => {
    const decoder = new SdkNewlineFrameDecoder(LIMIT);
    expect(decoder.push(Buffer.from('{"a":1}\n{"b":2}\n'))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it("flushes an unterminated in-bound remainder once", () => {
    const decoder = new SdkNewlineFrameDecoder(LIMIT);
    expect(decoder.push(Buffer.from('{"partial":true}'))).toEqual([]);
    expect(decoder.flush()).toBe('{"partial":true}');
    expect(decoder.flush()).toBeUndefined();
  });
});
