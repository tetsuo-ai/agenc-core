import { describe, expect, test } from "vitest";

import { makeToolResultMessage } from "../session-transcript.js";

// GAP #6 regression: clampResultText must cap by UTF-8 BYTE length, not by JS
// character count. The buggy version sliced `text.slice(0, MAX_BYTES)`
// CHARACTERS, so multi-byte (CJK / emoji) content was retained at up to ~3-4x
// the byte cap — defeating the memory bound. These tests drive the private
// clamp through the exported makeToolResultMessage and assert on the stored
// content's real UTF-8 byte length.
//
// Keep in lockstep with session-transcript.ts.
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const TRUNCATION_MARKER = /\[\d+ bytes truncated\]/;

function storedString(message: any): string {
  const content = message.message.content[0].content;
  return typeof content === "string"
    ? content
    : content.map((b: { text: string }) => b.text).join("\n");
}

describe("clampResultText byte cap on multi-byte content (GAP #6)", () => {
  test("a CJK result over the cap is clamped to <= the BYTE cap, not the char cap", () => {
    // Each "。" is 3 UTF-8 bytes. 40k chars = 120 KB > 64 KB cap. The buggy
    // char-slice would keep 64k CHARS ≈ 192 KB (~3x over). The byte-correct
    // clamp keeps at most the byte cap (+ a small marker line).
    const cjk = "。".repeat(40_000);
    const stored = storedString(makeToolResultMessage("call-cjk", cjk));

    const head = stored.replace(/\n\[\d+ bytes truncated\]$/, "");
    expect(Buffer.byteLength(head, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES,
    );
    // Whole stored string (head + marker) stays comfortably near the cap, not
    // multiples of it.
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES + 64,
    );
    expect(stored).toMatch(TRUNCATION_MARKER);
  });

  test("a 4-byte emoji result is clamped without splitting a code point (no U+FFFD)", () => {
    // "🚀" is 4 UTF-8 bytes (a surrogate pair in JS). 30k of them = 120 KB.
    const emoji = "🚀".repeat(30_000);
    const stored = storedString(makeToolResultMessage("call-emoji", emoji));

    const head = stored.replace(/\n\[\d+ bytes truncated\]$/, "");
    expect(Buffer.byteLength(head, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES,
    );
    // The clamp must never leave a partial multi-byte sequence (which would
    // decode to the replacement character U+FFFD).
    expect(head).not.toContain("�");
    // The kept head is a real prefix of the original — only whole rockets.
    expect(emoji.startsWith(head)).toBe(true);
    expect(stored).toMatch(TRUNCATION_MARKER);
  });

  test("ASCII content under the cap is returned unchanged (no marker)", () => {
    const ascii = "x".repeat(1024);
    const stored = storedString(makeToolResultMessage("call-ascii", ascii));
    expect(stored).toBe(ascii);
    expect(stored).not.toMatch(TRUNCATION_MARKER);
  });

  test("the reported truncated byte count equals original bytes minus kept head bytes", () => {
    const cjk = "界".repeat(50_000); // 3 bytes each = 150 KB
    const original = Buffer.byteLength(cjk, "utf8");
    const stored = storedString(makeToolResultMessage("call-count", cjk));

    const match = stored.match(/\[(\d+) bytes truncated\]$/);
    expect(match).not.toBeNull();
    const reported = Number(match![1]);
    const head = stored.replace(/\n\[\d+ bytes truncated\]$/, "");
    expect(reported).toBe(original - Buffer.byteLength(head, "utf8"));
    expect(reported).toBeGreaterThan(0);
  });
});
