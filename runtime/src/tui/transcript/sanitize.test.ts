import { describe, expect, test } from "vitest";

import {
  neutralizeControlCharsForDisplay,
  sanitizeTranscriptText,
} from "./sanitize.js";

describe("sanitizeTranscriptText", () => {
  test("strips SGR sequences from transcript text", () => {
    expect(sanitizeTranscriptText("a\x1b[31mred\x1b[0mz")).toBe("aredz");
  });

  test("turns erase and cursor-control sequences into a line boundary", () => {
    expect(sanitizeTranscriptText("line1\x1b[2Jline2")).toBe("line1\nline2");
    expect(sanitizeTranscriptText("line1\x1b[2Kline2")).toBe("line1\nline2");
  });
});

describe("neutralizeControlCharsForDisplay", () => {
  test("renders ESC as a visible literal escape", () => {
    expect(neutralizeControlCharsForDisplay("a\x1b[31mb")).toBe("a\\x1b[31mb");
  });

  test("preserves printable text and newlines", () => {
    expect(neutralizeControlCharsForDisplay("hello\nworld")).toBe("hello\nworld");
  });
});
