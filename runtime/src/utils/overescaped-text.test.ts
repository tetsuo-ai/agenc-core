import { describe, expect, it } from "vitest";
import { normalizeOverescapedToolText } from "./overescaped-text.js";

describe("normalizeOverescapedToolText", () => {
  it("decodes over-escaped multiline source blobs", () => {
    expect(
      normalizeOverescapedToolText(
        '#include "shell.h"\\nint main(void) {\\n  return 0;\\n}\\n',
      ),
    ).toBe('#include "shell.h"\nint main(void) {\n  return 0;\n}\n');
  });

  it("decodes over-escaped quote-only single-line text", () => {
    expect(normalizeOverescapedToolText('#include \\"shell.h\\"')).toBe(
      '#include "shell.h"',
    );
  });

  it("preserves legitimate in-code newline escapes", () => {
    expect(normalizeOverescapedToolText('printf("hi\\\\n");')).toBe(
      'printf("hi\\\\n");',
    );
  });

  it("decodes over-escaped json text without breaking inner escaped newlines", () => {
    const normalized = normalizeOverescapedToolText(
      '{\\"message\\": \\"hello\\\\nworld\\"}',
    );
    expect(normalized).toContain('hello\\nworld');
    expect(JSON.parse(normalized) as { message: string }).toEqual({
      message: "hello\nworld",
    });
  });
});
