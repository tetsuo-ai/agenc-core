import { describe, expect, it } from "vitest";

import { encodeBoundedJsonLine } from "../../src/app-server/transport/stdio.js";
import {
  AGENC_JSON_LINE_MAX_FRAME_BYTES,
  jsonLineFitsFrame,
  jsonLineFrameBytes,
  jsonUtf8Bytes,
} from "../../src/utils/json-line-frame.js";

describe("json-line frame budget", () => {
  it("counts the trailing newline as part of the shared frame", () => {
    const value = { hello: "world" };
    expect(jsonUtf8Bytes(value)).toBe(Buffer.byteLength(JSON.stringify(value), "utf8"));
    expect(jsonLineFrameBytes(value)).toBe(jsonUtf8Bytes(value) + 1);
    expect(jsonLineFitsFrame(value)).toBe(true);
    expect(AGENC_JSON_LINE_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
  });

  it("agrees with encodeBoundedJsonLine, including the newline", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "health.ping", params: {} };
    const line = encodeBoundedJsonLine(message);
    expect(Buffer.byteLength(line, "utf8")).toBe(jsonLineFrameBytes(message));
    expect(jsonLineFitsFrame(message, jsonLineFrameBytes(message))).toBe(true);
    expect(jsonLineFitsFrame(message, jsonLineFrameBytes(message) - 1)).toBe(
      false,
    );
  });

  it("rejects values that are not JSON-serializable", () => {
    expect(() => jsonLineFrameBytes(undefined)).toThrow(/not JSON-serializable/u);
  });
});
