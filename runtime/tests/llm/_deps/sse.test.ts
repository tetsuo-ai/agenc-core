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
});
