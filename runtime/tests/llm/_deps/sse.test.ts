import { describe, expect, test } from "vitest";
import {
  MAX_SSE_FRAME_BYTES,
  parseSSEFrames,
} from "./sse.js";
import { LLMInvalidResponseError } from "../errors.js";

describe("parseSSEFrames", () => {
  test("returns un-delimited remainder unchanged below the cap", () => {
    const partial = "data: hello"; // no frame separator yet
    const { frames, remaining } = parseSSEFrames(partial);
    expect(frames).toHaveLength(0);
    expect(remaining).toBe(partial);
  });

  test("aborts with LLMInvalidResponseError when the un-delimited remainder exceeds the cap", () => {
    // A misbehaving provider/proxy streams bytes continuously but never emits a
    // frame separator (\n\n). Without the cap this remainder would be returned
    // verbatim and re-accumulated forever, growing the heap to the full stream
    // size (OOM) while the idle watchdog never fires.
    const oversized = "x".repeat(MAX_SSE_FRAME_BYTES + 1);
    expect(() => parseSSEFrames(oversized, "openai")).toThrow(
      LLMInvalidResponseError,
    );
  });

  test("preserves mixed delimiters, multiline data, comments and an unfinished tail", () => {
    const body = ": keepalive\n\nevent: token\r\nid: 2\r\ndata: hello\r\ndata: world\r\n\r\ndata: next\n\ndata: unfinished";
    const expected = { frames: [{}, { event: "token", id: "2", data: "hello\nworld" }, { data: "next" }], remaining: "data: unfinished" };
    expect(parseSSEFrames(body)).toEqual(expected);
    // Every socket split, including splits inside CRLF separators.
    for (let split = 0; split <= body.length; split++) {
      const first = parseSSEFrames(body.slice(0, split));
      const second = parseSSEFrames(first.remaining + body.slice(split));
      expect({ frames: [...first.frames, ...second.frames], remaining: second.remaining }).toEqual(expected);
    }
  });

  test("retains the exact separator grammar and ignores empty or field-only frames", () => {
    expect(parseSSEFrames("\n\nevent: alone\n\ndata: a\n\r\ndata: b")).toEqual({ frames: [], remaining: "data: a\n\r\ndata: b" });
    expect(parseSSEFrames("data: a\rb\n\n")).toEqual({ frames: [{ data: "ab" }], remaining: "" });
  });

  test("handles many same-delimiter frames in one chunk in order", () => {
    for (const delimiter of ["\n\n", "\r\n\r\n"]) {
      const body = Array.from({ length: 10000 }, (_, i) => `data: ${i}${delimiter}`).join("");
      const result = parseSSEFrames(body);
      expect(result.frames.map(frame => frame.data)).toEqual(Array.from({ length: 10000 }, (_, i) => String(i)));
      expect(result.remaining).toBe("");
    }
  });
});
