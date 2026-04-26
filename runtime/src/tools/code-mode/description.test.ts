import { describe, expect, test } from "vitest";
import {
  normalizeCodeModeIdentifier,
  parseExecSource,
} from "./description.js";

describe("code-mode description helpers", () => {
  test("parses upstream-style exec pragma", () => {
    expect(
      parseExecSource(
        '// @exec: {"yield_time_ms": 25, "max_output_tokens": 50}\ntext("hi")',
      ),
    ).toEqual({
      code: 'text("hi")',
      yieldTimeMs: 25,
      maxOutputTokens: 50,
    });
  });

  test("rejects unknown pragma fields", () => {
    expect(() =>
      parseExecSource('// @exec: {"timeout": 1}\ntext("hi")'),
    ).toThrow("only supports");
  });

  test("normalizes tool names as JavaScript identifiers", () => {
    expect(normalizeCodeModeIdentifier("FileRead")).toBe("FileRead");
    expect(normalizeCodeModeIdentifier("mcp.ologs/get-profile")).toBe(
      "mcp_ologs_get_profile",
    );
  });
});
